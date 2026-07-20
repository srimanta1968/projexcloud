import { FastifyInstance } from 'fastify';
import { requireAuth } from '@projexlight/sdk-identity';
import {
  createContact,
  createDeal,
  createFunnelStage,
  getContact,
  getDeal,
  getPipelineBoard,
  getStaleDeals,
  listDeals,
  listFunnelStages,
  logActivity,
  transitionDeal,
  updateContact,
  updateDeal,
} from '../services/crmService';
import type { ActivityKind, DealStage, LifecycleStage } from '../models/crm.model';
import {
  setNextAction,
  getOpenNextAction,
  completeNextAction,
  checkSaveGate,
  DealNotFoundError,
} from '../services/nextActionService';

const STAGES: DealStage[] = ['qualifying', 'proposal', 'negotiation', 'closed-won', 'closed-lost'];
const ACTIVITY_KINDS: ActivityKind[] = ['call', 'email', 'meeting', 'note', 'task'];
const NEXT_ACTION_TYPES = ['call', 'email', 'meeting', 'task', 'linkedin', 'sms', 'proposal', 'other'];

export async function registerRoutes(app: FastifyInstance): Promise<void> {
  app.post('/api/crm/contacts', { preHandler: requireAuth }, async (req, reply) => {
    const body = req.body as Partial<{
      tenant_id: string;
      persona_id: string;
      lifecycle_stage: LifecycleStage;
      source: string;
      owner_persona_id: string;
      custom_fields: Record<string, unknown>;
      external_refs: Record<string, string>;
    }>;
    if (!body.tenant_id || !body.persona_id) {
      return reply.code(400).send({ error: 'ValidationError', details: ['missing fields'] });
    }
    const rec = await createContact({
      tenant_id: body.tenant_id,
      persona_id: body.persona_id,
      lifecycle_stage: body.lifecycle_stage,
      source: body.source,
      owner_persona_id: body.owner_persona_id,
      custom_fields: body.custom_fields,
      external_refs: body.external_refs,
    });
    return reply.code(201).send({ data: { contact: rec } });
  });

  app.get<{ Params: { contact_id: string } }>(
    '/api/crm/contacts/:contact_id',
    { preHandler: requireAuth },
    async (req, reply) => {
      const rec = await getContact(req.params.contact_id);
      if (!rec) return reply.code(404).send({ error: 'NotFound' });
      return reply.code(200).send({ data: { contact: rec } });
    },
  );

  app.patch<{ Params: { contact_id: string } }>(
    '/api/crm/contacts/:contact_id',
    { preHandler: requireAuth },
    async (req, reply) => {
      const rec = await updateContact(req.params.contact_id, req.body as Record<string, never>);
      if (!rec) return reply.code(404).send({ error: 'NotFound' });
      return reply.code(200).send({ data: { contact: rec } });
    },
  );

  app.post('/api/crm/deals', { preHandler: requireAuth }, async (req, reply) => {
    const body = req.body as Partial<{
      tenant_id: string;
      encounter_id: string;
      contact_id: string;
      name: string;
      amount: number;
      currency: string;
      close_probability: number;
      custom_fields: Record<string, unknown>;
      external_refs: Record<string, string>;
    }>;
    if (!body.tenant_id || !body.encounter_id || !body.name) {
      return reply.code(400).send({ error: 'ValidationError', details: ['missing fields'] });
    }
    const rec = await createDeal({
      tenant_id: body.tenant_id,
      encounter_id: body.encounter_id,
      contact_id: body.contact_id,
      name: body.name,
      amount: body.amount,
      currency: body.currency,
      close_probability: body.close_probability,
      custom_fields: body.custom_fields,
      external_refs: body.external_refs,
    });
    return reply.code(201).send({ data: { deal: rec } });
  });

  app.post<{ Params: { deal_id: string } }>(
    '/api/crm/deals/:deal_id/transition',
    { preHandler: requireAuth },
    async (req, reply) => {
      const body = req.body as Partial<{ stage: DealStage }>;
      if (!body.stage || !STAGES.includes(body.stage)) {
        return reply.code(400).send({ error: 'ValidationError', details: ['invalid stage'] });
      }
      const rec = await transitionDeal(req.params.deal_id, body.stage);
      if (!rec) return reply.code(404).send({ error: 'NotFound' });
      return reply.code(200).send({ data: { deal: rec } });
    },
  );

  // ---- Pipeline / deal board + stage-aging (TK-3629) ----

  app.get<{ Querystring: { tenant_id?: string; stage?: string; limit?: string; offset?: string } }>(
    '/api/crm/deals', { preHandler: requireAuth }, async (req, reply) => {
      if (!req.query.tenant_id) return reply.code(400).send({ error: 'ValidationError', details: ['tenant_id query param required'] });
      const deals = await listDeals(req.query.tenant_id, {
        stage: req.query.stage,
        limit: req.query.limit ? Number(req.query.limit) : undefined,
        offset: req.query.offset ? Number(req.query.offset) : undefined,
      });
      return reply.code(200).send({ data: { deals } });
    },
  );

  app.get<{ Params: { deal_id: string }; Querystring: { tenant_id?: string } }>(
    '/api/crm/deals/:deal_id', { preHandler: requireAuth }, async (req, reply) => {
      if (!req.query.tenant_id) return reply.code(400).send({ error: 'ValidationError', details: ['tenant_id query param required'] });
      const deal = await getDeal(req.query.tenant_id, req.params.deal_id);
      if (!deal) return reply.code(404).send({ error: 'NotFound' });
      return reply.code(200).send({ data: { deal } });
    },
  );

  app.patch<{ Params: { deal_id: string } }>(
    '/api/crm/deals/:deal_id', { preHandler: requireAuth }, async (req, reply) => {
      const body = (req.body ?? {}) as { tenant_id?: string };
      if (!body.tenant_id) return reply.code(400).send({ error: 'ValidationError', details: ['tenant_id is required'] });
      const deal = await updateDeal(body.tenant_id, req.params.deal_id, body as Parameters<typeof updateDeal>[2]);
      if (!deal) return reply.code(404).send({ error: 'NotFound' });
      return reply.code(200).send({ data: { deal } });
    },
  );

  app.get<{ Querystring: { tenant_id?: string } }>(
    '/api/crm/pipeline/board', { preHandler: requireAuth }, async (req, reply) => {
      if (!req.query.tenant_id) return reply.code(400).send({ error: 'ValidationError', details: ['tenant_id query param required'] });
      const board = await getPipelineBoard(req.query.tenant_id);
      return reply.code(200).send({ data: { board } });
    },
  );

  app.get<{ Querystring: { tenant_id?: string; business_days?: string } }>(
    '/api/crm/pipeline/stale', { preHandler: requireAuth }, async (req, reply) => {
      if (!req.query.tenant_id) return reply.code(400).send({ error: 'ValidationError', details: ['tenant_id query param required'] });
      const deals = await getStaleDeals(req.query.tenant_id, req.query.business_days ? Number(req.query.business_days) : 5);
      return reply.code(200).send({ data: { deals } });
    },
  );

  app.post('/api/crm/funnel-stages', { preHandler: requireAuth }, async (req, reply) => {
    const body = req.body as Partial<{
      tenant_id: string; name: string; sort_order: number; description: string; criteria: string;
      probability: number; is_default: boolean; is_terminal: boolean; is_won: boolean;
    }>;
    if (!body.tenant_id || !body.name) {
      return reply.code(400).send({ error: 'ValidationError', details: ['tenant_id and name are required'] });
    }
    const stage = await createFunnelStage(body as { tenant_id: string; name: string });
    return reply.code(201).send({ data: { stage } });
  });

  app.get<{ Querystring: { tenant_id?: string } }>(
    '/api/crm/funnel-stages', { preHandler: requireAuth }, async (req, reply) => {
      if (!req.query.tenant_id) return reply.code(400).send({ error: 'ValidationError', details: ['tenant_id query param required'] });
      const stages = await listFunnelStages(req.query.tenant_id);
      return reply.code(200).send({ data: { stages } });
    },
  );

  app.post('/api/crm/activities', { preHandler: requireAuth }, async (req, reply) => {
    const body = req.body as Partial<{
      encounter_id: string;
      kind: ActivityKind;
      actor_persona_id: string;
      summary: string;
      occurred_at: string;
    }>;
    if (!body.encounter_id || !body.kind || !body.actor_persona_id) {
      return reply.code(400).send({ error: 'ValidationError', details: ['missing fields'] });
    }
    if (!ACTIVITY_KINDS.includes(body.kind)) {
      return reply.code(400).send({ error: 'ValidationError', details: ['invalid activity kind'] });
    }
    const rec = await logActivity({
      encounter_id: body.encounter_id,
      kind: body.kind,
      actor_persona_id: body.actor_persona_id,
      summary: body.summary,
      occurred_at: body.occurred_at,
    });
    return reply.code(201).send({ data: { activity: rec } });
  });

  /* --------------------------------------------- NEXT-action + save-gate (TK-3630) */
  // Set (replace) the deal's open NEXT action.
  app.post<{ Params: { deal_id: string } }>(
    '/api/crm/deals/:deal_id/next-action', { preHandler: requireAuth }, async (req, reply) => {
      const body = req.body as Partial<{
        tenant_id: string; action_type: string; owner_persona_id: string; due_at: string; purpose: string;
      }>;
      if (!body.tenant_id || !body.due_at) {
        return reply.code(400).send({ error: 'ValidationError', details: ['tenant_id and due_at are required'] });
      }
      if (body.action_type && !NEXT_ACTION_TYPES.includes(body.action_type)) {
        return reply.code(400).send({ error: 'ValidationError', details: [`action_type must be one of ${NEXT_ACTION_TYPES.join(', ')}`] });
      }
      try {
        const next_action = await setNextAction({
          tenantId: body.tenant_id, dealId: req.params.deal_id, actionType: body.action_type,
          ownerPersonaId: body.owner_persona_id, dueAt: body.due_at, purpose: body.purpose,
        });
        return reply.code(201).send({ data: { next_action } });
      } catch (err) {
        if (err instanceof DealNotFoundError) return reply.code(404).send({ error: 'NotFound', details: ['deal not found'] });
        throw err;
      }
    },
  );

  // Get the deal's current open NEXT action.
  app.get<{ Params: { deal_id: string }; Querystring: { tenant_id?: string } }>(
    '/api/crm/deals/:deal_id/next-action', { preHandler: requireAuth }, async (req, reply) => {
      if (!req.query.tenant_id) return reply.code(400).send({ error: 'ValidationError', details: ['tenant_id query param required'] });
      const next_action = await getOpenNextAction(req.query.tenant_id, req.params.deal_id);
      if (!next_action) return reply.code(404).send({ error: 'NotFound', details: ['no open NEXT action for this deal'] });
      return reply.code(200).send({ data: { next_action } });
    },
  );

  // Complete the open NEXT action with an outcome.
  app.post<{ Params: { deal_id: string } }>(
    '/api/crm/deals/:deal_id/next-action/complete', { preHandler: requireAuth }, async (req, reply) => {
      const body = (req.body ?? {}) as { tenant_id?: string; outcome?: string };
      if (!body.tenant_id) return reply.code(400).send({ error: 'ValidationError', details: ['tenant_id is required'] });
      const next_action = await completeNextAction(body.tenant_id, req.params.deal_id, body.outcome);
      if (!next_action) return reply.code(404).send({ error: 'NotFound', details: ['no open NEXT action to complete'] });
      return reply.code(200).send({ data: { next_action } });
    },
  );

  // Save-gate verdict: is this deal allowed to save/advance? (terminal, or has open NEXT action).
  app.get<{ Params: { deal_id: string }; Querystring: { tenant_id?: string } }>(
    '/api/crm/deals/:deal_id/save-gate', { preHandler: requireAuth }, async (req, reply) => {
      if (!req.query.tenant_id) return reply.code(400).send({ error: 'ValidationError', details: ['tenant_id query param required'] });
      try {
        const gate = await checkSaveGate(req.query.tenant_id, req.params.deal_id);
        return reply.code(200).send({ data: { gate } });
      } catch (err) {
        if (err instanceof DealNotFoundError) return reply.code(404).send({ error: 'NotFound', details: ['deal not found'] });
        throw err;
      }
    },
  );
}
