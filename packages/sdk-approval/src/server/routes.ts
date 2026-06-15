import { FastifyInstance } from 'fastify';
import { requireAuth } from '@projexlight/sdk-identity';
import {
  createRouteHandler,
  decideHandler,
  getRequestHandler,
  submitRequestHandler,
} from './handlers/approvalController';
import {
  BreakGlassError,
  decideBreakGlass,
  getBreakGlass,
  requestBreakGlass,
  useBreakGlass,
} from '../services/breakGlassService';
import type { Decision } from '../models/approval.model';

/**
 * Registers /api/approvals/* routes per P4-Operational-Billing §11.
 */
export async function registerRoutes(app: FastifyInstance): Promise<void> {
  app.post('/api/approvals/routes', { preHandler: requireAuth }, async (req, reply) => {
    try { await createRouteHandler(req, reply); }
    catch (err) { req.log.error(err); if (!reply.sent) reply.code(500).send({ error: 'InternalError' }); }
  });

  app.post('/api/approvals/requests', { preHandler: requireAuth }, async (req, reply) => {
    try { await submitRequestHandler(req, reply); }
    catch (err) { req.log.error(err); if (!reply.sent) reply.code(500).send({ error: 'InternalError' }); }
  });

  app.post<{ Params: { step_id: string } }>(
    '/api/approvals/steps/:step_id/decide',
    { preHandler: requireAuth },
    async (req, reply) => {
      try { await decideHandler(req, reply); }
      catch (err) { req.log.error(err); if (!reply.sent) reply.code(500).send({ error: 'InternalError' }); }
    },
  );

  app.get<{ Params: { request_id: string } }>(
    '/api/approvals/requests/:request_id',
    { preHandler: requireAuth },
    async (req, reply) => {
      try { await getRequestHandler(req, reply); }
      catch (err) { req.log.error(err); if (!reply.sent) reply.code(500).send({ error: 'InternalError' }); }
    },
  );

  // ── P10/E4 — audited break-glass emergency access ────────────────────────
  const personaOf = (req: { auth?: { primary_persona_id?: string | null; sub?: string } }): string =>
    req.auth?.primary_persona_id ?? req.auth?.sub ?? '';

  // POST /api/break-glass — open a scoped, approval-gated emergency request.
  app.post<{
    Body: { route_id?: string; tenant_id?: string; scope?: Record<string, unknown>; justification?: string; ttl_minutes?: number };
  }>('/api/break-glass', { preHandler: requireAuth }, async (req, reply) => {
    const b = req.body ?? {};
    const tenant_id = b.tenant_id ?? req.auth?.tenant_id ?? '';
    if (!b.route_id || !tenant_id || !b.justification) {
      return reply.code(400).send({ error: 'ValidationError', details: ['route_id, tenant_id, justification are required'] });
    }
    try {
      const result = await requestBreakGlass({
        tenant_id,
        route_id: b.route_id,
        requester_persona_id: personaOf(req),
        scope: b.scope ?? {},
        justification: b.justification,
        ttl_minutes: b.ttl_minutes,
      });
      return reply.code(201).send({ data: result });
    } catch (err) {
      if (err instanceof BreakGlassError) return reply.code(400).send({ error: 'BreakGlass', details: [err.message] });
      req.log.error(err); if (!reply.sent) reply.code(500).send({ error: 'InternalError' });
    }
  });

  // POST /api/break-glass/:grant_id/decide — approve/reject the gating request.
  app.post<{ Params: { grant_id: string }; Body: { step_id?: string; decision?: Decision; reason?: string } }>(
    '/api/break-glass/:grant_id/decide',
    { preHandler: requireAuth },
    async (req, reply) => {
      const b = req.body ?? {};
      if (!b.step_id || (b.decision !== 'approve' && b.decision !== 'reject')) {
        return reply.code(400).send({ error: 'ValidationError', details: ['step_id and decision (approve|reject) are required'] });
      }
      try {
        const grant = await decideBreakGlass(req.params.grant_id, b.step_id, personaOf(req), b.decision, b.reason);
        return reply.code(200).send({ data: { grant } });
      } catch (err) {
        if (err instanceof BreakGlassError) return reply.code(400).send({ error: 'BreakGlass', details: [err.message] });
        req.log.error(err); if (!reply.sent) reply.code(500).send({ error: 'InternalError' });
      }
    },
  );

  // POST /api/break-glass/:grant_id/use — exercise the grant, emit a certificate.
  app.post<{ Params: { grant_id: string }; Body: { action?: string; target_id?: string } }>(
    '/api/break-glass/:grant_id/use',
    { preHandler: requireAuth },
    async (req, reply) => {
      const b = req.body ?? {};
      if (!b.action) {
        return reply.code(400).send({ error: 'ValidationError', details: ['action is required'] });
      }
      try {
        const certificate = await useBreakGlass(req.params.grant_id, {
          action: b.action,
          target_id: b.target_id,
          acting_persona_id: personaOf(req),
        });
        return reply.code(200).send({ data: { certificate } });
      } catch (err) {
        if (err instanceof BreakGlassError) return reply.code(403).send({ error: 'BreakGlass', details: [err.message] });
        req.log.error(err); if (!reply.sent) reply.code(500).send({ error: 'InternalError' });
      }
    },
  );

  // GET /api/break-glass/:grant_id — read grant status + latest certificate.
  app.get<{ Params: { grant_id: string } }>(
    '/api/break-glass/:grant_id',
    { preHandler: requireAuth },
    async (req, reply) => {
      try {
        const grant = await getBreakGlass(req.params.grant_id);
        if (!grant) return reply.code(404).send({ error: 'NotFound' });
        return reply.code(200).send({ data: { grant } });
      } catch (err) {
        req.log.error(err); if (!reply.sent) reply.code(500).send({ error: 'InternalError' });
      }
    },
  );
}
