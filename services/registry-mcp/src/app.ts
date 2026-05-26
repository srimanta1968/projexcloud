import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import cors from '@fastify/cors';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import type { Registry } from '@projexlight/sdk-registry';
import type { RegistryMcpConfig } from './config';
import { AuthError, extractTenantContext, type TenantContext } from './auth';
import { buildMcpServer, type AuditSink } from './mcpHandler';
import { createInProcessRateLimiter, type RateLimiter } from './rateLimit';
import type { RegistryRef } from './catalogSource';

export interface AppDeps {
  config: RegistryMcpConfig;
  /** Pin one Registry for the app's lifetime (no hot-reload). */
  registry?: Registry;
  /** Ref handed by createRegistryRef + startCatalogWatcher (hot-reload). */
  registryRef?: RegistryRef;
  embeddingsLoaded: boolean;
  audit?: AuditSink;
  rateLimiter?: RateLimiter;
}

interface SessionEntry {
  transport: SSEServerTransport;
  tenant: TenantContext;
}

const SSE_PATH = '/mcp/sse';
const MESSAGES_PATH = '/mcp/messages';
const HEALTH_PATH = '/healthz';

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

  app.get(SSE_PATH, async (req: FastifyRequest, reply: FastifyReply) => {
    let tenant: TenantContext;
    try {
      tenant = extractTenantContext(req.headers.authorization, deps.config);
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
        ? { registryRef: deps.registryRef, tenant, audit: deps.audit }
        : { registry: deps.registry as Registry, tenant, audit: deps.audit },
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
