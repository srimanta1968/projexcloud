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
// ACTIVITY_KINDS is the single source of truth in the model (widened with
// 'voicemail' by migration 003) — do not re-declare the list here.
import { ACTIVITY_KINDS } from '../models/crm.model';
import type { ActivityKind, DealStage, LifecycleStage, LogCallInput, LogVoicemailInput } from '../models/crm.model';
import {
  logCall,
  logVoicemail,
  listCallActivities,
  InvalidCallActivity,
} from '../services/callActivityService';
import {
  setNextAction,
  getOpenNextAction,
  completeNextAction,
  checkSaveGate,
  DealNotFoundError,
} from '../services/nextActionService';
import {
  checkStageTransition,
  guardedTransition,
  StageTransitionError,
  DealNotFoundError as StageDealNotFoundError,
} from '../services/stageGuardService';

const STAGES: DealStage[] = ['qualifying', 'proposal', 'negotiation', 'closed-won', 'closed-lost'];
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
      try {
        // Guarded: validity + criteria + terminal gating. Emits the event only on a permitted move.
        const rec = await guardedTransition(req.params.deal_id, body.stage);
        if (!rec) return reply.code(404).send({ error: 'NotFound' });
        return reply.code(200).send({ data: { deal: rec } });
      } catch (err) {
        if (err instanceof StageDealNotFoundError) return reply.code(404).send({ error: 'NotFound', details: ['deal not found'] });
        if (err instanceof StageTransitionError) return reply.code(409).send({ error: 'InvalidTransition', details: [(err as Error).message] });
        throw err;
      }
    },
  );

  // Stage-guard verdict: may this deal move to :to_stage? (validity + criteria + terminal gating).
  app.get<{ Params: { deal_id: string }; Querystring: { tenant_id?: string; to_stage?: string } }>(
    '/api/crm/deals/:deal_id/stage-guard', { preHandler: requireAuth }, async (req, reply) => {
      if (!req.query.tenant_id) return reply.code(400).send({ error: 'ValidationError', details: ['tenant_id query param required'] });
      const to = req.query.to_stage as DealStage | undefined;
      if (!to || !STAGES.includes(to)) return reply.code(400).send({ error: 'ValidationError', details: ['to_stage query param must be a valid stage'] });
      try {
        const gate = await checkStageTransition(req.params.deal_id, to);
        return reply.code(200).send({ data: { gate } });
      } catch (err) {
        if (err instanceof StageDealNotFoundError) return reply.code(404).send({ error: 'NotFound', details: ['deal not found'] });
        throw err;
      }
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

  /* ------------------------------------------ call / voicemail activity (TK-3656) */

  // Log a call with its disposition on the contact/lead timeline. Idempotent on
  // external_call_id so telephony webhook retries update rather than duplicate.
  app.post('/api/crm/activities/call', { preHandler: requireAuth }, async (req, reply) => {
    const body = (req.body ?? {}) as Partial<LogCallInput>;
    if (!body.encounter_id || !body.actor_persona_id) {
      return reply.code(400).send({ error: 'ValidationError', details: ['encounter_id and actor_persona_id are required'] });
    }
    try {
      const activity = await logCall(body as LogCallInput);
      return reply.code(201).send({ data: { activity } });
    } catch (err) {
      if (err instanceof InvalidCallActivity) {
        return reply.code(400).send({ error: 'ValidationError', details: err.details });
      }
      throw err;
    }
  });

  // Log a voicemail (with optional transcript) on the timeline.
  app.post('/api/crm/activities/voicemail', { preHandler: requireAuth }, async (req, reply) => {
    const body = (req.body ?? {}) as Partial<LogVoicemailInput>;
    if (!body.encounter_id || !body.actor_persona_id) {
      return reply.code(400).send({ error: 'ValidationError', details: ['encounter_id and actor_persona_id are required'] });
    }
    try {
      const activity = await logVoicemail(body as LogVoicemailInput);
      return reply.code(201).send({ data: { activity } });
    } catch (err) {
      if (err instanceof InvalidCallActivity) {
        return reply.code(400).send({ error: 'ValidationError', details: err.details });
      }
      throw err;
    }
  });

  // Read the call/voicemail timeline for an encounter.
  app.get<{ Querystring: { encounter_id?: string; kind?: string; call_disposition?: string; limit?: string; offset?: string } }>(
    '/api/crm/activities/calls', { preHandler: requireAuth }, async (req, reply) => {
      if (!req.query.encounter_id) {
        return reply.code(400).send({ error: 'ValidationError', details: ['encounter_id query param required'] });
      }
      const activities = await listCallActivities(req.query.encounter_id, {
        kind: req.query.kind,
        call_disposition: req.query.call_disposition,
        limit: req.query.limit ? Number(req.query.limit) : undefined,
        offset: req.query.offset ? Number(req.query.offset) : undefined,
      });
      return reply.code(200).send({ data: { activities } });
    },
  );

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
