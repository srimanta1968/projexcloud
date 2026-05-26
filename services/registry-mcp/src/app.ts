import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import cors from '@fastify/cors';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import type { Registry } from '@projexlight/sdk-registry';
import type { RegistryMcpConfig } from './config';
import { AuthError, extractTenantContext, type ApiKeyResolver, type TenantContext } from './auth';
import { buildMcpServer, type AuditSink, type AuditEventEmitter } from './mcpHandler';
import { createInProcessRateLimiter, type RateLimiter } from './rateLimit';
import type { RegistryRef } from './catalogSource';
import { WRITE_TOOLS, dispatchWriteTool, type WriteToolDeps } from './writeTools';
import { READ_TOOLS, dispatchTool, type ToolResult } from '@projexlight/registry-mcp-local/dist/tools';

const WRITE_TOOL_NAMES = new Set(WRITE_TOOLS.map((t) => t.name));

function extractCallErrorCode(result: { content?: Array<{ type?: string; text?: string }>; isError?: boolean }): string | undefined {
  if (!result.isError) return undefined;
  const first = result.content?.[0];
  if (!first?.text) return undefined;
  try {
    const parsed = JSON.parse(first.text) as { code?: string };
    return typeof parsed.code === 'string' ? parsed.code : undefined;
  } catch {
    return undefined;
  }
}

export interface AppDeps {
  config: RegistryMcpConfig;
  /** Pin one Registry for the app's lifetime (no hot-reload). */
  registry?: Registry;
  /** Ref handed by createRegistryRef + startCatalogWatcher (hot-reload). */
  registryRef?: RegistryRef;
  embeddingsLoaded: boolean;
  audit?: AuditSink;
  /** FR-MCP-6 — registry.tool.invoked.v1 emitter. */
  auditEmit?: AuditEventEmitter;
  rateLimiter?: RateLimiter;
  /** FR-MCP-3 — x-projex-api-key resolver wired to sdk-api-keys.verifyKey. */
  apiKeyResolver?: ApiKeyResolver;
  /** FR-MCP-2 / FR-MCP-7 — tenant view + approval + deploy bridges. */
  writeToolDeps?: WriteToolDeps;
}

interface SessionEntry {
  transport: SSEServerTransport;
  tenant: TenantContext;
}

const SSE_PATH = '/mcp/sse';
const MESSAGES_PATH = '/mcp/messages';
const HEALTH_PATH = '/healthz';
const CATALOG_PATH = '/registry/catalog';

export function buildApp(deps: AppDeps): FastifyInstance {
  if (!deps.registry && !deps.registryRef) {
    throw new Error('AppDeps requires registry or registryRef');
  }
  const app = Fastify({ logger: { level: process.env.LOG_LEVEL ?? 'info' } });
  const limiter = deps.rateLimiter ?? createInProcessRateLimiter(deps.config.rateLimitPerTenantPerMin);
  const sessions = new Map<string, SessionEntry>();

  const currentRegistry = (): Registry =>
    deps.registryRef ? deps.registryRef.current : (deps.registry as Registry);

  app.register(cors, { origin: true, credentials: true });

  app.get(HEALTH_PATH, async () => ({
    status: 'ok',
    catalog_entries: currentRegistry().list().length,
    embeddings_loaded: deps.registryRef?.embeddingsLoaded ?? deps.embeddingsLoaded,
    sessions: sessions.size,
    catalog_reload_count: deps.registryRef?.reloadCount ?? 0,
    catalog_loaded_at: deps.registryRef?.lastLoadedAt ?? null,
    catalog_source_mtime_ms: deps.registryRef?.lastSourceMtimeMs ?? null,
  }));

  /**
   * Stateless tool-call surface for the local MCP proxy (FR-MCP-L4) and
   * the cloud-builder /api/build/* routes. Same authn as SSE — Bearer or
   * x-projex-api-key. Returns the same ToolResult shape the SSE transport
   * would have produced, so callers can treat both transports identically.
   */
  app.post('/mcp/v1/call', async (req: FastifyRequest, reply: FastifyReply) => {
    let tenant: TenantContext;
    try {
      tenant = await extractTenantContext(req.headers, deps.config, {
        apiKeyResolver: deps.apiKeyResolver,
      });
    } catch (e) {
      const err = e as AuthError;
      reply.code(err.statusCode).send({ error: err.message });
      return reply;
    }
    const limit = limiter.check(tenant.tenant_id ?? tenant.sub);
    if (!limit.ok) {
      reply.code(429).send({ error: 'rate limited' });
      return reply;
    }
    const body = req.body as { name?: string; arguments?: Record<string, unknown> };
    if (!body?.name) {
      reply.code(400).send({ error: 'name is required' });
      return reply;
    }
    const args = body.arguments ?? {};
    const t0 = Date.now();
    const isWrite = WRITE_TOOL_NAMES.has(body.name);
    const result = isWrite
      ? await dispatchWriteTool(body.name, args, currentRegistry(), tenant, deps.writeToolDeps ?? {})
      : await dispatchTool(body.name, args, currentRegistry());
    const duration_ms = Date.now() - t0;
    const errorCode = extractCallErrorCode(result);
    deps.audit?.({ tenant, tool: body.name, ok: !result.isError, duration_ms, args, error_code: errorCode });
    deps.auditEmit?.({ tenant, tool: body.name, args, ok: !result.isError, duration_ms, error_code: errorCode });
    reply.send(result);
    return reply;
  });

  /**
   * FR-MCP-L3 — local MCP cache refresh endpoint. Returns the full catalog
   * (manifest + dependency graph). ETag = source mtime so daily background
   * pull from the local MCP can short-circuit when nothing changed.
   */
  app.get(CATALOG_PATH, async (req: FastifyRequest, reply: FastifyReply) => {
    const ref = deps.registryRef;
    const reg = currentRegistry();
    const mtime = ref?.lastSourceMtimeMs ?? 0;
    const etag = `"r-${mtime}"`;
    if (req.headers['if-none-match'] === etag) {
      reply.code(304).send();
      return reply;
    }
    reply.header('ETag', etag);
    reply.header('Cache-Control', 'private, max-age=300');
    reply.send({
      catalog_entries: reg.list(),
      source_mtime_ms: mtime,
      reload_count: ref?.reloadCount ?? 0,
    });
    return reply;
  });

  app.get(SSE_PATH, async (req: FastifyRequest, reply: FastifyReply) => {
    let tenant: TenantContext;
    try {
      tenant = await extractTenantContext(req.headers, deps.config, {
        apiKeyResolver: deps.apiKeyResolver,
      });
    } catch (e) {
      const err = e as AuthError;
      reply.code(err.statusCode).send({ error: err.message });
      return reply;
    }

    const limit = limiter.check(tenant.tenant_id ?? tenant.sub);
    if (!limit.ok) {
      reply.code(429).send({ error: 'rate limited' });
      return reply;
    }

    const transport = new SSEServerTransport(MESSAGES_PATH, reply.raw);
    const server = buildMcpServer(
      deps.registryRef
        ? {
            registryRef: deps.registryRef,
            tenant,
            audit: deps.audit,
            auditEmit: deps.auditEmit,
            writeToolDeps: deps.writeToolDeps,
          }
        : {
            registry: deps.registry as Registry,
            tenant,
            audit: deps.audit,
            auditEmit: deps.auditEmit,
            writeToolDeps: deps.writeToolDeps,
          },
    );
    await server.connect(transport);
    sessions.set(transport.sessionId, { transport, tenant });
    req.raw.on('close', () => {
      sessions.delete(transport.sessionId);
      transport.close().catch(() => undefined);
    });

    return reply;
  });

  app.post(MESSAGES_PATH, async (req: FastifyRequest, reply: FastifyReply) => {
    const sessionId = (req.query as { sessionId?: string }).sessionId;
    if (!sessionId) {
      reply.code(400).send({ error: 'sessionId query param required' });
      return reply;
    }
    const entry = sessions.get(sessionId);
    if (!entry) {
      reply.code(404).send({ error: 'unknown session' });
      return reply;
    }
    const limit = limiter.check(entry.tenant.tenant_id ?? entry.tenant.sub);
    if (!limit.ok) {
      reply.code(429).send({ error: 'rate limited' });
      return reply;
    }
    await entry.transport.handlePostMessage(req.raw, reply.raw, req.body);
    return reply;
  });

  return app;
}
