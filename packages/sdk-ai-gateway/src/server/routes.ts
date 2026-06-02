import { FastifyInstance } from 'fastify';
import { requireAuth } from '@projexlight/sdk-identity';
import { completeHandler, streamHandler } from './handlers/completionController';
import {
  bindCredentialHandler,
  rotateCredentialHandler,
  revokeCredentialHandler,
  listCredentialsHandler,
} from './handlers/tenantCredentialController';

/**
 * Registers /api/ai-gateway/* routes. complete + stream are the runtime
 * surfaces; /tenant-credentials/* is the BYOK admin surface (FR-BYOK-3..6).
 * Admin endpoints for provider/route_rule CRUD live in the tenant-admin
 * portal and call the underlying tables directly.
 */
export async function registerRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/ai-gateway/health', async () => ({ sdk: 'sdk-ai-gateway', status: 'ok' }));

  app.post('/api/ai-gateway/complete', { preHandler: requireAuth }, async (req, reply) => {
    try {
      await completeHandler(req as Parameters<typeof completeHandler>[0], reply);
    } catch (err) {
      req.log.error(err);
      if (!reply.sent) reply.code(500).send({ success: false, error: 'InternalError' });
    }
  });

  app.post('/api/ai-gateway/stream', { preHandler: requireAuth }, async (req, reply) => {
    try {
      await streamHandler(req as Parameters<typeof streamHandler>[0], reply);
    } catch (err) {
      req.log.error(err);
      // Stream may already have headers flushed; best-effort close.
      try {
        reply.raw.end();
      } catch {
        /* ignore */
      }
    }
  });

  // ─── Tenant-BYOK for AI provider keys (FR-BYOK-3..6) ───────────────
  app.post('/api/ai-gateway/tenant-credentials', { preHandler: requireAuth }, async (req, reply) => {
    try {
      await bindCredentialHandler(req as Parameters<typeof bindCredentialHandler>[0], reply);
    } catch (err) {
      req.log.error(err);
      if (!reply.sent) reply.code(500).send({ success: false, error: 'InternalError' });
    }
  });

  app.patch<{ Params: { binding_id: string } }>(
    '/api/ai-gateway/tenant-credentials/:binding_id',
    { preHandler: requireAuth },
    async (req, reply) => {
      try {
        await rotateCredentialHandler(req as Parameters<typeof rotateCredentialHandler>[0], reply);
      } catch (err) {
        req.log.error(err);
        if (!reply.sent) reply.code(500).send({ success: false, error: 'InternalError' });
      }
    },
  );

  app.delete<{ Params: { binding_id: string } }>(
    '/api/ai-gateway/tenant-credentials/:binding_id',
    { preHandler: requireAuth },
    async (req, reply) => {
      try {
        await revokeCredentialHandler(req as Parameters<typeof revokeCredentialHandler>[0], reply);
      } catch (err) {
        req.log.error(err);
        if (!reply.sent) reply.code(500).send({ success: false, error: 'InternalError' });
      }
    },
  );

  app.get('/api/ai-gateway/tenant-credentials', { preHandler: requireAuth }, async (req, reply) => {
    try {
      await listCredentialsHandler(req as Parameters<typeof listCredentialsHandler>[0], reply);
    } catch (err) {
      req.log.error(err);
      if (!reply.sent) reply.code(500).send({ success: false, error: 'InternalError' });
    }
  });
}
