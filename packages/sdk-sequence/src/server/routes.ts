import { FastifyInstance } from 'fastify';
import { requireAuth } from '@projexlight/sdk-identity';
import {
  addStep,
  createSequence,
  createTemplate,
  createTrigger,
  enroll,
  getSequence,
  listSequences,
} from '../services/sequenceService';

/**
 * sdk-sequence Fastify routes (P14·E1, TK-3613). CRUD for sequences / templates
 * / steps / triggers plus idempotent event-based enrollment. All tenant-authed.
 */
export async function registerRoutes(app: FastifyInstance): Promise<void> {
  app.post('/api/sequences', { preHandler: requireAuth }, async (req, reply) => {
    const body = req.body as Partial<{
      tenant_id: string; name: string; description: string; sequence_type: string;
      owner_persona_id: string; is_default: boolean; metadata: Record<string, unknown>;
    }>;
    if (!body.tenant_id || !body.name) {
      return reply.code(400).send({ error: 'ValidationError', details: ['tenant_id and name are required'] });
    }
    const sequence = await createSequence({
      tenant_id: body.tenant_id, name: body.name, description: body.description,
      sequence_type: body.sequence_type, owner_persona_id: body.owner_persona_id,
      is_default: body.is_default, metadata: body.metadata,
    });
    return reply.code(201).send({ data: { sequence } });
  });

  app.get<{ Querystring: { tenant_id?: string } }>(
    '/api/sequences', { preHandler: requireAuth }, async (req, reply) => {
      if (!req.query.tenant_id) {
        return reply.code(400).send({ error: 'ValidationError', details: ['tenant_id query param required'] });
      }
      const sequences = await listSequences(req.query.tenant_id);
      return reply.code(200).send({ data: { sequences } });
    },
  );

  app.get<{ Params: { sequence_id: string }; Querystring: { tenant_id?: string } }>(
    '/api/sequences/:sequence_id', { preHandler: requireAuth }, async (req, reply) => {
      if (!req.query.tenant_id) {
        return reply.code(400).send({ error: 'ValidationError', details: ['tenant_id query param required'] });
      }
      const sequence = await getSequence(req.query.tenant_id, req.params.sequence_id);
      if (!sequence) return reply.code(404).send({ error: 'NotFound' });
      return reply.code(200).send({ data: { sequence } });
    },
  );

  app.post('/api/sequence-templates', { preHandler: requireAuth }, async (req, reply) => {
    const body = req.body as Partial<{
      tenant_id: string; name: string; channel: string; subject: string; body: string;
      category: string; variables: unknown[];
    }>;
    if (!body.tenant_id || !body.name) {
      return reply.code(400).send({ error: 'ValidationError', details: ['tenant_id and name are required'] });
    }
    const template = await createTemplate({
      tenant_id: body.tenant_id, name: body.name, channel: body.channel, subject: body.subject,
      body: body.body, category: body.category, variables: body.variables,
    });
    return reply.code(201).send({ data: { template } });
  });

  app.post<{ Params: { sequence_id: string } }>(
    '/api/sequences/:sequence_id/steps', { preHandler: requireAuth }, async (req, reply) => {
      const body = req.body as Partial<{
        tenant_id: string; step_number: number; channel: string; action: string;
        template_id: string; subject: string; body: string; schedule_mode: string;
        delay_seconds: number; send_mode: string;
      }>;
      if (!body.tenant_id || body.step_number === undefined) {
        return reply.code(400).send({ error: 'ValidationError', details: ['tenant_id and step_number are required'] });
      }
      const step = await addStep({
        tenant_id: body.tenant_id, sequence_id: req.params.sequence_id, step_number: body.step_number,
        channel: body.channel, action: body.action, template_id: body.template_id, subject: body.subject,
        body: body.body, schedule_mode: body.schedule_mode, delay_seconds: body.delay_seconds, send_mode: body.send_mode,
      });
      return reply.code(201).send({ data: { step } });
    },
  );

  app.post<{ Params: { sequence_id: string } }>(
    '/api/sequences/:sequence_id/triggers', { preHandler: requireAuth }, async (req, reply) => {
      const body = req.body as Partial<{
        tenant_id: string; event_type: string; stage_id: string; trigger_on: string;
        condition_json: Record<string, unknown>; enabled: boolean;
      }>;
      if (!body.tenant_id) {
        return reply.code(400).send({ error: 'ValidationError', details: ['tenant_id is required'] });
      }
      const trigger = await createTrigger({
        tenant_id: body.tenant_id, sequence_id: req.params.sequence_id, event_type: body.event_type,
        stage_id: body.stage_id, trigger_on: body.trigger_on, condition_json: body.condition_json, enabled: body.enabled,
      });
      return reply.code(201).send({ data: { trigger } });
    },
  );

  app.post<{ Params: { sequence_id: string } }>(
    '/api/sequences/:sequence_id/enroll', { preHandler: requireAuth }, async (req, reply) => {
      const body = req.body as Partial<{ tenant_id: string; subject_persona_id: string; event_type: string }>;
      if (!body.tenant_id || !body.subject_persona_id) {
        return reply.code(400).send({ error: 'ValidationError', details: ['tenant_id and subject_persona_id are required'] });
      }
      try {
        const enrollment = await enroll({
          tenant_id: body.tenant_id, sequence_id: req.params.sequence_id,
          subject_persona_id: body.subject_persona_id, event_type: body.event_type,
        });
        // 200 when the persona was already enrolled (idempotent), 201 on a new run.
        return reply.code(enrollment.already_enrolled ? 200 : 201).send({ data: { enrollment } });
      } catch (err) {
        return reply.code(409).send({ error: 'EnrollFailed', details: [(err as Error).message] });
      }
    },
  );
}
