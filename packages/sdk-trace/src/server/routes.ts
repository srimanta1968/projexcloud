import { FastifyInstance } from 'fastify';
import { requireAuth } from '@projexlight/sdk-identity';
import {
  timelineHandler,
  exportHandler,
  regressionAssertHandler,
} from './handlers/traceController';

/**
 * Registers /api/trace/* routes.
 *   GET  /api/trace/:trace_id              (timeline — G12)
 *   POST /api/trace/exports                (signed PDF/JSON bundle)
 *   POST /api/trace/regression-assert      (FR-TRC-8 / G-7)
 */
export async function registerRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/trace/health', async () => ({ sdk: 'sdk-trace', status: 'ok' }));

  app.get('/api/trace/:trace_id', { preHandler: requireAuth }, async (req, reply) => {
    try {
      await timelineHandler(req as Parameters<typeof timelineHandler>[0], reply);
    } catch (err) {
      req.log.error(err);
      if (!reply.sent) reply.code(500).send({ success: false, error: 'InternalError' });
    }
  });

  app.post('/api/trace/exports', { preHandler: requireAuth }, async (req, reply) => {
    try {
      await exportHandler(req as Parameters<typeof exportHandler>[0], reply);
    } catch (err) {
      req.log.error(err);
      if (!reply.sent) reply.code(500).send({ success: false, error: 'InternalError' });
    }
  });

  app.post('/api/trace/regression-assert', { preHandler: requireAuth }, async (req, reply) => {
    try {
      await regressionAssertHandler(req as Parameters<typeof regressionAssertHandler>[0], reply);
    } catch (err) {
      req.log.error(err);
      if (!reply.sent) reply.code(500).send({ success: false, error: 'InternalError' });
    }
  });
}
