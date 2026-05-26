/**
 * P9 / E3 — local MCP write-proxy (FR-MCP-L1, FR-MCP-L4, FR-MCP-L5).
 *
 * Mirrors the hosted MCP's write-tool surface so an AI client sees one
 * unified tool list regardless of where the local MCP is running. Calls
 * are forwarded to the hosted MCP over HTTP-streamable transport using
 * the dev's stored API key. When the hosted side is unreachable, writes
 * are queued to ~/.projex/cache/write-queue.jsonl (FR-MCP-L5) and
 * `projex registry drain` replays them on reconnect.
 */

import { existsSync, mkdirSync, appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import type { ToolDefinition, ToolResult } from './tools';

export const WRITE_TOOLS: ToolDefinition[] = [
  {
    name: 'projex_registry_list_my_sdks',
    description: "Tenant-scoped: lists only the SDKs the caller's tenant has in module_subscriptions.",
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'projex_registry_list_my_blueprints',
    description: "Tenant-scoped: blueprints filtered by the caller's tenant pack.",
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'projex_registry_request_pack_upgrade',
    description: 'Open an approval request for tenant admin to upgrade compliance pack.',
    inputSchema: {
      type: 'object',
      properties: {
        target_pack: { type: 'string', enum: ['healthcare', 'finserv', 'public-sector'] },
        reason: { type: 'string' },
      },
      required: ['target_pack'],
    },
  },
  {
    name: 'projex_registry_deploy',
    description:
      "Server-side deploy: stages a scaffold into the tenant's app pool, runs migrations, returns a deploy_id + URL.",
    inputSchema: {
      type: 'object',
      properties: {
        app_name: { type: 'string' },
        sdk_names: { type: 'array', items: { type: 'string' } },
        env: { type: 'string', enum: ['trial', 'staging', 'prod'] },
      },
      required: ['app_name', 'sdk_names'],
    },
  },
];

const WRITE_TOOL_NAMES = new Set(WRITE_TOOLS.map((t) => t.name));

export function isWriteTool(name: string): boolean {
  return WRITE_TOOL_NAMES.has(name);
}

function projexHome(): string {
  return process.env.PROJEX_HOME ?? join(homedir(), '.projex');
}

function queuePath(): string {
  return join(projexHome(), 'cache', 'write-queue.jsonl');
}

function authPath(): string {
  return join(projexHome(), 'auth.json');
}

interface StoredAuth {
  hosted_url?: string;
  api_key?: string;
  saved_at?: string;
}

function loadAuth(): StoredAuth {
  const path = authPath();
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as StoredAuth;
  } catch {
    return {};
  }
}

export interface ProxySettings {
  hostedUrl: string;
  apiKey: string;
}

/** Resolve the proxy target. Env wins; otherwise reads ~/.projex/auth.json. */
export function resolveProxySettings(): ProxySettings | null {
  const hostedUrl = process.env.PROJEX_HOSTED_MCP ?? loadAuth().hosted_url;
  const apiKey = process.env.PROJEX_API_KEY ?? loadAuth().api_key;
  if (!hostedUrl || !apiKey) return null;
  return { hostedUrl: hostedUrl.replace(/\/$/, ''), apiKey };
}

interface QueueEntry {
  queued_at: string;
  tool: string;
  args: Record<string, unknown>;
  queue_id: string;
}

function ensureQueueDir(): void {
  const dir = dirname(queuePath());
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

function enqueueWrite(tool: string, args: Record<string, unknown>): QueueEntry {
  ensureQueueDir();
  const entry: QueueEntry = {
    queued_at: new Date().toISOString(),
    tool,
    args,
    queue_id: `q-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
  };
  appendFileSync(queuePath(), JSON.stringify(entry) + '\n', { encoding: 'utf8' });
  return entry;
}

function ok(payload: unknown): ToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }] };
}

function err(message: string, code?: string): ToolResult {
  const body = code ? { error: message, code } : { error: message };
  return { content: [{ type: 'text', text: JSON.stringify(body, null, 2) }], isError: true };
}

/**
 * Proxy a write-tool call to the hosted MCP. On HTTP/network failure,
 * queues the call and returns a `{ status: 'queued', queue_id }` ToolResult.
 *
 * Uses the streamable HTTP endpoint exposed by the hosted MCP (POST to
 * /mcp/messages?sessionId=...) — but for write tools we accept the
 * simpler `POST /mcp/v1/call` shape that hosted's app.ts dispatches via
 * a stateless tool call endpoint when present. If only SSE is available
 * we fall back to a single JSON-RPC envelope.
 */
export async function proxyWriteTool(
  name: string,
  args: Record<string, unknown>,
  settings: ProxySettings,
): Promise<ToolResult> {
  try {
    const url = `${settings.hostedUrl}/mcp/v1/call`;
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-projex-api-key': settings.apiKey,
      },
      body: JSON.stringify({ name, arguments: args }),
      signal: AbortSignal.timeout(parseInt(process.env.PROJEX_HOSTED_TIMEOUT_MS ?? '15000', 10)),
    });
    if (!res.ok) {
      const text = await res.text();
      return err(`hosted MCP returned ${res.status}: ${text.slice(0, 200)}`, 'HOSTED_HTTP_ERROR');
    }
    const body = (await res.json()) as ToolResult;
    return body;
  } catch (e) {
    // Network or timeout — queue + advise drain command.
    const entry = enqueueWrite(name, args);
    return ok({
      status: 'queued',
      queue_id: entry.queue_id,
      queued_at: entry.queued_at,
      reason: (e as Error).message,
      drain_command: 'projex registry drain',
      note: 'Hosted MCP unreachable — call queued locally. Re-run drain after connectivity returns to apply this write.',
    });
  }
}

/** Read queued entries (used by `projex registry drain`). */
export function readQueue(): QueueEntry[] {
  const path = queuePath();
  if (!existsSync(path)) return [];
  const lines = readFileSync(path, 'utf8').split(/\r?\n/).filter(Boolean);
  return lines.map((l) => JSON.parse(l) as QueueEntry);
}

/** Replace the queue file (used after drain). */
export function rewriteQueue(remaining: QueueEntry[]): void {
  const path = queuePath();
  ensureQueueDir();
  if (remaining.length === 0) {
    writeFileSync(path, '', { encoding: 'utf8' });
    return;
  }
  writeFileSync(path, remaining.map((e) => JSON.stringify(e)).join('\n') + '\n', { encoding: 'utf8' });
}

/** Drain queued writes against the hosted MCP. Stops on first failure. */
export async function drainQueue(settings: ProxySettings): Promise<{
  drained: Array<{ queue_id: string; tool: string; ok: boolean; result?: unknown; error?: string }>;
  remaining_count: number;
}> {
  const queue = readQueue();
  const drained: Array<{ queue_id: string; tool: string; ok: boolean; result?: unknown; error?: string }> = [];
  const remaining: QueueEntry[] = [];

  for (let i = 0; i < queue.length; i++) {
    const entry = queue[i];
    try {
      const result = await proxyWriteTool(entry.tool, entry.args, settings);
      if (result.isError) {
        drained.push({ queue_id: entry.queue_id, tool: entry.tool, ok: false, error: (result.content[0] as { text: string }).text });
        // Leave this + all later entries queued for next drain so we don't
        // skip them silently.
        remaining.push(...queue.slice(i));
        break;
      }
      drained.push({ queue_id: entry.queue_id, tool: entry.tool, ok: true, result });
    } catch (e) {
      drained.push({ queue_id: entry.queue_id, tool: entry.tool, ok: false, error: (e as Error).message });
      remaining.push(...queue.slice(i));
      break;
    }
  }

  rewriteQueue(remaining);
  return { drained, remaining_count: remaining.length };
}

export type { QueueEntry };
