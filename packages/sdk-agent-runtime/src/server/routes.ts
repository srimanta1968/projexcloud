import { FastifyInstance } from 'fastify';
import { requireAuth } from '@projexlight/sdk-identity';
import {
  mintHandler,
  revokeHandler,
  validateHandler,
} from './handlers/capabilityTokenController';
import { replayHandler } from './handlers/replayController';
import { rollbackHandler } from './handlers/rollbackController';
import {
  createAgentDefinitionHandler,
  getAgentDefinitionHandler,
  listAgentDefinitionsHandler,
  startAgentRunHandler,
  getAgentRunHandler,
  listAgentRunsHandler,
} from './handlers/agentRunController';

/**
 * Registers /api/agent-runtime/* routes. Capability-token surface lands
 * first (TK-3275); run lifecycle + replay + scope endpoints follow.
 *
 * Auth: every mutation requires a valid JWT (requireAuth pre-handler).
 * Meter:    the @meter() decorator on the issuer methods records usage
 *           against agent-runtime.capability-token.mint.
 */
export async function registerRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/agent-runtime/health', async () => ({ sdk: 'sdk-agent-runtime', status: 'ok' }));

  app.post('/api/agent-runtime/tokens', { preHandler: requireAuth }, async (req, reply) => {
    try {
      await mintHandler(req as Parameters<typeof mintHandler>[0], reply);
    } catch (err) {
      req.log.error(err);
      if (!reply.sent) reply.code(500).send({ success: false, error: 'InternalError' });
    }
  });

  app.post('/api/agent-runtime/tokens/:token_id/validate', { preHandler: requireAuth }, async (req, reply) => {
    try {
      await validateHandler(req as Parameters<typeof validateHandler>[0], reply);
    } catch (err) {
      req.log.error(err);
      if (!reply.sent) reply.code(500).send({ success: false, error: 'InternalError' });
    }
  });

  app.post('/api/agent-runtime/tokens/:token_id/revoke', { preHandler: requireAuth }, async (req, reply) => {
    try {
      await revokeHandler(req as Parameters<typeof revokeHandler>[0], reply);
    } catch (err) {
      req.log.error(err);
      if (!reply.sent) reply.code(500).send({ success: false, error: 'InternalError' });
    }
  });

  // Replay (TK-3278 / AC-5) and rollback (TK-3301 / AC-8) endpoints.
  app.post('/api/agent-runtime/runs/:run_id/replay', { preHandler: requireAuth }, async (req, reply) => {
    try {
      await replayHandler(req as Parameters<typeof replayHandler>[0], reply);
    } catch (err) {
      req.log.error(err);
      if (!reply.sent) reply.code(500).send({ success: false, error: 'InternalError' });
    }
  });

  app.post('/api/agent-runtime/runs/:run_id/rollback', { preHandler: requireAuth }, async (req, reply) => {
    try {
      await rollbackHandler(req as Parameters<typeof rollbackHandler>[0], reply);
    } catch (err) {
      req.log.error(err);
      if (!reply.sent) reply.code(500).send({ success: false, error: 'InternalError' });
    }
  });

  // TK-3282 — agent_definition CRUD.
  app.post('/api/agent-runtime/agents', { preHandler: requireAuth }, async (req, reply) => {
    try {
      await createAgentDefinitionHandler(req as Parameters<typeof createAgentDefinitionHandler>[0], reply);
    } catch (err) {
      req.log.error(err);
      if (!reply.sent) reply.code(500).send({ success: false, error: 'InternalError' });
    }
  });
  app.get('/api/agent-runtime/agents/:id', { preHandler: requireAuth }, async (req, reply) => {
    try {
      await getAgentDefinitionHandler(req as Parameters<typeof getAgentDefinitionHandler>[0], reply);
    } catch (err) {
      req.log.error(err);
      if (!reply.sent) reply.code(500).send({ success: false, error: 'InternalError' });
    }
  });
  app.get('/api/agent-runtime/agents', { preHandler: requireAuth }, async (req, reply) => {
    try {
      await listAgentDefinitionsHandler(req as Parameters<typeof listAgentDefinitionsHandler>[0], reply);
    } catch (err) {
      req.log.error(err);
      if (!reply.sent) reply.code(500).send({ success: false, error: 'InternalError' });
    }
  });

  // TK-3283 — agent_run lifecycle.
  app.post('/api/agent-runtime/runs', { preHandler: requireAuth }, async (req, reply) => {
    try {
      await startAgentRunHandler(req as Parameters<typeof startAgentRunHandler>[0], reply);
    } catch (err) {
      req.log.error(err);
      if (!reply.sent) reply.code(500).send({ success: false, error: 'InternalError' });
    }
  });
  app.get('/api/agent-runtime/runs/:id', { preHandler: requireAuth }, async (req, reply) => {
    try {
      await getAgentRunHandler(req as Parameters<typeof getAgentRunHandler>[0], reply);
    } catch (err) {
      req.log.error(err);
      if (!reply.sent) reply.code(500).send({ success: false, error: 'InternalError' });
    }
  });
  app.get('/api/agent-runtime/runs', { preHandler: requireAuth }, async (req, reply) => {
    try {
      await listAgentRunsHandler(req as Parameters<typeof listAgentRunsHandler>[0], reply);
    } catch (err) {
      req.log.error(err);
      if (!reply.sent) reply.code(500).send({ success: false, error: 'InternalError' });
    }
  });
}
