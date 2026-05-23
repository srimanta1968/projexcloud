import { FastifyInstance } from 'fastify';
import { requireAuth } from '@projexlight/sdk-identity';
import {
  advanceJourneyRun,
  computeSegment,
  createCampaign,
  startJourneyRun,
  upsertJourney,
  upsertSegment,
} from '../services/campaignService';

export async function registerRoutes(app: FastifyInstance): Promise<void> {
  app.post('/api/campaigns', { preHandler: requireAuth }, async (req, reply) => {
    const body = req.body as Partial<{ tenant_id: string; name: string; variant_flag_id: string }>;
    if (!body.tenant_id || !body.name) return reply.code(400).send({ error: 'ValidationError', details: ['missing fields'] });
    const rec = await createCampaign({ tenant_id: body.tenant_id, name: body.name, variant_flag_id: body.variant_flag_id });
    return reply.code(201).send({ data: { campaign: rec } });
  });

  app.post<{ Params: { campaign_id: string } }>(
    '/api/campaigns/:campaign_id/segments',
    { preHandler: requireAuth },
    async (req, reply) => {
      const body = req.body as Partial<{ dsl: Record<string, unknown> }>;
      const rec = await upsertSegment({ campaign_id: req.params.campaign_id, dsl: body.dsl ?? {} });
      return reply.code(201).send({ data: { segment: rec } });
    },
  );

  app.post<{ Params: { segment_id: string } }>(
    '/api/campaigns/segments/:segment_id/compute',
    { preHandler: requireAuth },
    async (req, reply) => {
      const rec = await computeSegment(req.params.segment_id);
      if (!rec) return reply.code(404).send({ error: 'NotFound' });
      return reply.code(200).send({ data: { segment: rec } });
    },
  );

  app.post<{ Params: { campaign_id: string } }>(
    '/api/campaigns/:campaign_id/journeys',
    { preHandler: requireAuth },
    async (req, reply) => {
      const body = req.body as Partial<{ steps: Array<Record<string, unknown>> }>;
      const rec = await upsertJourney({ campaign_id: req.params.campaign_id, steps: body.steps ?? [] });
      return reply.code(201).send({ data: { journey: rec } });
    },
  );

  app.post<{ Params: { journey_id: string } }>(
    '/api/campaigns/journeys/:journey_id/runs',
    { preHandler: requireAuth },
    async (req, reply) => {
      const body = req.body as Partial<{ subject_persona_id: string }>;
      if (!body.subject_persona_id) return reply.code(400).send({ error: 'ValidationError', details: ['missing subject_persona_id'] });
      const rec = await startJourneyRun({ journey_id: req.params.journey_id, subject_persona_id: body.subject_persona_id });
      return reply.code(201).send({ data: { run: rec } });
    },
  );

  app.post<{ Params: { run_id: string } }>(
    '/api/campaigns/runs/:run_id/advance',
    { preHandler: requireAuth },
    async (req, reply) => {
      const rec = await advanceJourneyRun(req.params.run_id);
      if (!rec) return reply.code(404).send({ error: 'NotFound' });
      return reply.code(200).send({ data: { run: rec } });
    },
  );
}
