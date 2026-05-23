import { FastifyInstance } from 'fastify';
import { requireAuth } from '@projexlight/sdk-identity';
import {
  createContact,
  createDeal,
  getContact,
  logActivity,
  transitionDeal,
  updateContact,
} from '../services/crmService';
import type { ActivityKind, DealStage, LifecycleStage } from '../models/crm.model';

const STAGES: DealStage[] = ['qualifying', 'proposal', 'negotiation', 'closed-won', 'closed-lost'];
const ACTIVITY_KINDS: ActivityKind[] = ['call', 'email', 'meeting', 'note', 'task'];

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
}
