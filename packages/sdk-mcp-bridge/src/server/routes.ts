import { FastifyInstance } from 'fastify';
import { requireAuth } from '@projexlight/sdk-identity';
import {
  registerServerHandler,
  getServerHandler,
  listServersHandler,
  disableServerHandler,
  invokeToolHandler,
} from './handlers/mcpController';

/**
 * Registers /api/mcp/* routes.
 *   POST   /api/mcp/server-registrations          (register + auto-discover)
 *   GET    /api/mcp/server-registrations/:id      (read)
 *   GET    /api/mcp/server-registrations          (list by tenant)
 *   POST   /api/mcp/server-registrations/:id/disable
 *   POST   /api/mcp/tools/:tool_id/invoke         (capability-token gated)
 */
export async function registerRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/mcp/health', async () => ({ sdk: 'sdk-mcp-bridge', status: 'ok' }));

  app.post('/api/mcp/server-registrations', { preHandler: requireAuth }, async (req, reply) => {
    try {
      await registerServerHandler(req as Parameters<typeof registerServerHandler>[0], reply);
    } catch (err) {
      req.log.error(err);
      if (!reply.sent) reply.code(500).send({ success: false, error: 'InternalError' });
    }
  });

  app.get('/api/mcp/server-registrations/:id', { preHandler: requireAuth }, async (req, reply) => {
    try {
      await getServerHandler(req as Parameters<typeof getServerHandler>[0], reply);
    } catch (err) {
      req.log.error(err);
      if (!reply.sent) reply.code(500).send({ success: false, error: 'InternalError' });
    }
  });

  app.get('/api/mcp/server-registrations', { preHandler: requireAuth }, async (req, reply) => {
    try {
      await listServersHandler(req as Parameters<typeof listServersHandler>[0], reply);
    } catch (err) {
      req.log.error(err);
      if (!reply.sent) reply.code(500).send({ success: false, error: 'InternalError' });
    }
  });

  app.post('/api/mcp/server-registrations/:id/disable', { preHandler: requireAuth }, async (req, reply) => {
    try {
      await disableServerHandler(req as Parameters<typeof disableServerHandler>[0], reply);
    } catch (err) {
      req.log.error(err);
      if (!reply.sent) reply.code(500).send({ success: false, error: 'InternalError' });
    }
  });

  app.post('/api/mcp/tools/:tool_id/invoke', { preHandler: requireAuth }, async (req, reply) => {
    try {
      await invokeToolHandler(req as Parameters<typeof invokeToolHandler>[0], reply);
    } catch (err) {
      req.log.error(err);
      if (!reply.sent) reply.code(500).send({ success: false, error: 'InternalError' });
    }
  });
}
