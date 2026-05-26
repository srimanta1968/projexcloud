/**
 * Wires the MCP Server for one SSE session. Reuses READ_TOOLS + dispatchTool
 * from @projexlight/registry-mcp-local so the read surface matches the local
 * stdio MCP byte-for-byte. The hosted variant adds:
 *   - WRITE_TOOLS (FR-MCP-2) — list_my_sdks, list_my_blueprints, deploy,
 *     request_pack_upgrade
 *   - registry.tool.invoked.v1 audit event emission (FR-MCP-6) via the
 *     auditEmit callback wired by index.ts to sdk-audit.emitEvent
 *   - meter sink (existing) for sdk-meter SKU counting
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import type { Registry } from '@projexlight/sdk-registry';
import { READ_TOOLS, dispatchTool } from '@projexlight/registry-mcp-local/dist/tools';
import type { TenantContext } from './auth';
import type { RegistryRef } from './catalogSource';
import { WRITE_TOOLS, dispatchWriteTool, type WriteToolDeps } from './writeTools';

const SERVER_NAME = 'projex-registry-mcp-hosted';
const SERVER_VERSION = '0.1.0';

const WRITE_TOOL_NAMES = new Set(WRITE_TOOLS.map((t) => t.name));

export interface AuditSink {
  (event: {
    tenant: TenantContext;
    tool: string;
    ok: boolean;
    duration_ms: number;
    args?: Record<string, unknown>;
    error_code?: string;
  }): void;
}

/**
 * registry.tool.invoked.v1 emitter (FR-MCP-6). Wired by index.ts to
 * sdk-audit.emitEvent. Best-effort — a failed emit must not block the
 * MCP response.
 */
export interface AuditEventEmitter {
  (input: {
    tenant: TenantContext;
    tool: string;
    args: Record<string, unknown>;
    ok: boolean;
    duration_ms: number;
    error_code?: string;
  }): void;
}

export interface BuildMcpServerOpts {
  tenant: TenantContext;
  audit?: AuditSink;
  auditEmit?: AuditEventEmitter;
  writeToolDeps?: WriteToolDeps;
  /** Either pin one Registry for the session, or hand a ref so hot-reloads land mid-session. */
  registry?: Registry;
  registryRef?: RegistryRef;
}

export function buildMcpServer(opts: BuildMcpServerOpts): Server {
  if (!opts.registry && !opts.registryRef) {
    throw new Error('buildMcpServer requires either registry or registryRef');
  }
  const resolveRegistry = (): Registry =>
    opts.registryRef ? opts.registryRef.current : (opts.registry as Registry);

  const writeDeps: WriteToolDeps = opts.writeToolDeps ?? {};

  const server = new Server(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [...READ_TOOLS, ...WRITE_TOOLS],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { name, arguments: args } = req.params;
    const startedAt = Date.now();
    const argv = (args ?? {}) as Record<string, unknown>;
    const isWrite = WRITE_TOOL_NAMES.has(name);

    const result = isWrite
      ? await dispatchWriteTool(name, argv, resolveRegistry(), opts.tenant, writeDeps)
      : await dispatchTool(name, argv, resolveRegistry());

    const duration_ms = Date.now() - startedAt;
    const errorCode = extractErrorCode(result);

    opts.audit?.({
      tenant: opts.tenant,
      tool: name,
      ok: !result.isError,
      duration_ms,
      args: argv,
      error_code: errorCode,
    });

    opts.auditEmit?.({
      tenant: opts.tenant,
      tool: name,
      args: argv,
      ok: !result.isError,
      duration_ms,
      error_code: errorCode,
    });

    return result as never;
  });

  return server;
}

/**
 * Best-effort error-code extraction from a write-tool ToolResult — the
 * payloads are JSON-encoded as a text block, so we parse it. Used to pass
 * codes like PACK_GATED into the audit chain for AC-7 replay.
 */
function extractErrorCode(result: { content?: Array<{ type: string; text?: string }>; isError?: boolean }): string | undefined {
  if (!result.isError) return undefined;
  const first = result.content?.[0];
  if (!first?.text) return undefined;
  try {
    const parsed = JSON.parse(first.text);
    if (parsed && typeof parsed.code === 'string') return parsed.code;
  } catch {
    // text isn't JSON; that's the read-tool error shape — no code field.
  }
  return undefined;
}
