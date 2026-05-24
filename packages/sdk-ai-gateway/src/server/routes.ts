import { FastifyInstance } from 'fastify';
import { requireAuth } from '@projexlight/sdk-identity';
import { completeHandler, streamHandler } from './handlers/completionController';

/**
 * Registers /api/ai-gateway/* routes. complete + stream are the only
 * public surfaces; admin endpoints for provider/route_rule CRUD live in
 * the tenant-admin portal and call the underlying tables directly.
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
}
