import { FastifyInstance } from 'fastify';
import { requireAuth } from '@projexlight/sdk-identity';
import {
  createHandoff,
  getHandoff,
  listHandoffs,
  transitionHandoff,
  updateHandoff,
  InvalidHandoffTransition,
} from '../services/handoffService';
import type { CreateHandoffInput, HandoffStatus, UpdateHandoffInput } from '../models/handoff.model';

const STATUSES: HandoffStatus[] = ['draft', 'pending', 'accepted', 'rejected', 'completed', 'cancelled'];

/**
 * HTTP surface for sdk-handoff (P15·E2). Sales→Delivery handoff CRUD plus the
 * status-lifecycle transition endpoint. Tenant-scoped; every call requires auth.
 */
export async function registerRoutes(app: FastifyInstance): Promise<void> {
  app.post('/api/handoffs', { preHandler: requireAuth }, async (req, reply) => {
    const body = (req.body ?? {}) as Partial<CreateHandoffInput>;
    if (!body.tenant_id || !body.from_persona_id) {
      return reply.code(400).send({ error: 'ValidationError', details: ['tenant_id and from_persona_id are required'] });
    }
    const rec = await createHandoff(body as CreateHandoffInput);
    return reply.code(201).send({ data: { handoff: rec } });
  });

  app.get<{ Querystring: { tenant_id?: string; status?: string; deal_id?: string; limit?: string; offset?: string } }>(
    '/api/handoffs', { preHandler: requireAuth }, async (req, reply) => {
      if (!req.query.tenant_id) return reply.code(400).send({ error: 'ValidationError', details: ['tenant_id query param required'] });
      const handoffs = await listHandoffs(req.query.tenant_id, {
        status: req.query.status,
        deal_id: req.query.deal_id,
        limit: req.query.limit ? Number(req.query.limit) : undefined,
        offset: req.query.offset ? Number(req.query.offset) : undefined,
      });
      return reply.code(200).send({ data: { handoffs } });
    },
  );

  app.get<{ Params: { handoff_id: string }; Querystring: { tenant_id?: string } }>(
    '/api/handoffs/:handoff_id', { preHandler: requireAuth }, async (req, reply) => {
      if (!req.query.tenant_id) return reply.code(400).send({ error: 'ValidationError', details: ['tenant_id query param required'] });
      const rec = await getHandoff(req.query.tenant_id, req.params.handoff_id);
      if (!rec) return reply.code(404).send({ error: 'NotFound' });
      return reply.code(200).send({ data: { handoff: rec } });
    },
  );

  app.patch<{ Params: { handoff_id: string } }>(
    '/api/handoffs/:handoff_id', { preHandler: requireAuth }, async (req, reply) => {
      const body = (req.body ?? {}) as { tenant_id?: string } & UpdateHandoffInput;
      if (!body.tenant_id) return reply.code(400).send({ error: 'ValidationError', details: ['tenant_id is required'] });
      const rec = await updateHandoff(body.tenant_id, req.params.handoff_id, body);
      if (!rec) {
        // Either not found, or no longer editable (status past pending).
        const exists = await getHandoff(body.tenant_id, req.params.handoff_id);
        if (!exists) return reply.code(404).send({ error: 'NotFound' });
        return reply.code(409).send({ error: 'NotEditable', message: `handoff in status '${exists.status}' is no longer editable` });
      }
      return reply.code(200).send({ data: { handoff: rec } });
    },
  );

  app.post<{ Params: { handoff_id: string } }>(
    '/api/handoffs/:handoff_id/transition', { preHandler: requireAuth }, async (req, reply) => {
      const body = (req.body ?? {}) as { tenant_id?: string; status?: HandoffStatus; reject_reason?: string };
      if (!body.tenant_id || !body.status) {
        return reply.code(400).send({ error: 'ValidationError', details: ['tenant_id and status are required'] });
      }
      if (!STATUSES.includes(body.status)) {
        return reply.code(400).send({ error: 'ValidationError', details: ['invalid status'] });
      }
      try {
        const rec = await transitionHandoff(body.tenant_id, req.params.handoff_id, body.status, {
          reject_reason: body.reject_reason,
        });
        if (!rec) return reply.code(404).send({ error: 'NotFound' });
        return reply.code(200).send({ data: { handoff: rec } });
      } catch (err) {
        if (err instanceof InvalidHandoffTransition) {
          return reply.code(409).send({ error: 'InvalidTransition', message: err.message });
        }
        throw err;
      }
    },
  );
}
