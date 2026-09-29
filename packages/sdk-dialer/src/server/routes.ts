import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { requireAuth } from '@projexlight/sdk-identity';
import {
  createCampaign,
  getCampaign,
  listCampaigns,
  listContacts,
  transitionCampaign,
  upsertContacts,
  type CampaignAction,
  type CreateCampaignInput,
} from '../services/campaignService';
import { dialContact } from '../services/dispatchService';
import { capacitySnapshot } from '../services/capacityService';
import { dispatchQueued } from '../services/queueDispatcher';
import { resolveTenant } from './tenantScope';
import { sendError } from './sendError';

const num = (v: string | undefined): number | undefined => (v === undefined ? undefined : Number(v));
const actorOf = (req: { auth?: { primary_persona_id?: string | null; sub?: string } }): string | null =>
  req.auth?.primary_persona_id ?? req.auth?.sub ?? null;

/**
 * sdk-dialer HTTP surface under /api/dialer/* (VA·E5), mounted by the api-gateway.
 * Every route is tenant-scoped through resolveTenant.
 */
export async function registerRoutes(app: FastifyInstance): Promise<void> {
  // TK-4479 — campaigns.
  app.post('/api/dialer/campaigns', { preHandler: requireAuth }, async (req, reply) => {
    const body = (req.body ?? {}) as CreateCampaignInput & { tenant_id?: string };
    const tenantId = resolveTenant(req, reply, body.tenant_id);
    if (!tenantId) return reply;
    try {
      return reply.code(201).send({ data: { campaign: await createCampaign(tenantId, body, actorOf(req)) } });
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.get<{ Querystring: { tenant_id?: string; status?: string; agent_id?: string; limit?: string; offset?: string } }>(
    '/api/dialer/campaigns', { preHandler: requireAuth }, async (req, reply) => {
      const tenantId = resolveTenant(req, reply, req.query.tenant_id);
      if (!tenantId) return reply;
      try {
        return reply.code(200).send({
          data: await listCampaigns(tenantId, { status: req.query.status, agent_id: req.query.agent_id, limit: num(req.query.limit), offset: num(req.query.offset) }),
        });
      } catch (err) {
        return sendError(reply, err);
      }
    },
  );

  app.get<{ Params: { campaign_id: string }; Querystring: { tenant_id?: string } }>(
    '/api/dialer/campaigns/:campaign_id', { preHandler: requireAuth }, async (req, reply) => {
      const tenantId = resolveTenant(req, reply, req.query.tenant_id);
      if (!tenantId) return reply;
      const campaign = await getCampaign(tenantId, req.params.campaign_id);
      if (!campaign) return reply.code(404).send({ error: 'NotFound', details: ['campaign not found'] });
      return reply.code(200).send({ data: { campaign } });
    },
  );

  // Batch upsert (1-1000) by external_ref; 200 because a re-sent batch updates in place.
  app.post<{ Params: { campaign_id: string } }>(
    '/api/dialer/campaigns/:campaign_id/contacts', { preHandler: requireAuth }, async (req, reply) => {
      const body = (req.body ?? {}) as { contacts?: unknown; tenant_id?: string };
      const tenantId = resolveTenant(req, reply, body.tenant_id);
      if (!tenantId) return reply;
      try {
        return reply.code(200).send({ data: await upsertContacts(tenantId, req.params.campaign_id, body, actorOf(req)) });
      } catch (err) {
        return sendError(reply, err);
      }
    },
  );

  app.get<{ Params: { campaign_id: string }; Querystring: { tenant_id?: string; status?: string; limit?: string; offset?: string } }>(
    '/api/dialer/campaigns/:campaign_id/contacts', { preHandler: requireAuth }, async (req, reply) => {
      const tenantId = resolveTenant(req, reply, req.query.tenant_id);
      if (!tenantId) return reply;
      try {
        return reply.code(200).send({
          data: await listContacts(tenantId, req.params.campaign_id, { status: req.query.status, limit: num(req.query.limit), offset: num(req.query.offset) }),
        });
      } catch (err) {
        return sendError(reply, err);
      }
    },
  );

  // TK-4480 — dial one contact now, through placeCall and the same gate chain as an API call.
  app.post<{ Params: { campaign_id: string; contact_id: string } }>(
    '/api/dialer/campaigns/:campaign_id/contacts/:contact_id/dial', { preHandler: requireAuth }, async (req, reply) => {
      const body = (req.body ?? {}) as { tenant_id?: string };
      const tenantId = resolveTenant(req, reply, body.tenant_id);
      if (!tenantId) return reply;
      try {
        const { call, replayed } = await dialContact(tenantId, req.params.campaign_id, req.params.contact_id, actorOf(req));
        return reply.code(replayed ? 200 : 201).send({ data: { call, replayed } });
      } catch (err) {
        return sendError(reply, err);
      }
    },
  );

  // TK-4484 — concurrency in use vs. caps, and an on-demand drain of the tenant's queue.
  app.get<{ Querystring: { tenant_id?: string } }>('/api/dialer/capacity', { preHandler: requireAuth }, async (req, reply) => {
    const tenantId = resolveTenant(req, reply, req.query.tenant_id);
    if (!tenantId) return reply;
    return reply.code(200).send({ data: { capacity: await capacitySnapshot(tenantId) } });
  });

  app.post('/api/dialer/dispatch', { preHandler: requireAuth }, async (req, reply) => {
    const body = (req.body ?? {}) as { tenant_id?: string; limit?: unknown };
    const tenantId = resolveTenant(req, reply, body.tenant_id);
    if (!tenantId) return reply;
    const limit = body.limit ?? 50;
    if (!Number.isInteger(limit) || (limit as number) < 1 || (limit as number) > 500) {
      return reply.code(400).send({ error: 'ValidationError', details: ['limit must be an integer between 1 and 500'] });
    }
    return reply.code(200).send({ data: await dispatchQueued(tenantId, limit as number) });
  });

  // Lifecycle actions — literal paths (not a loop) so route scanners and docs see each one.
  const transition = (action: CampaignAction) => async (
    req: FastifyRequest<{ Params: { campaign_id: string } }>,
    reply: FastifyReply,
  ): Promise<FastifyReply> => {
    const body = (req.body ?? {}) as { tenant_id?: string };
    const tenantId = resolveTenant(req, reply, body.tenant_id);
    if (!tenantId) return reply;
    try {
      return reply.code(200).send({ data: { campaign: await transitionCampaign(tenantId, req.params.campaign_id, action, actorOf(req)) } });
    } catch (err) {
      return sendError(reply, err);
    }
  };
  app.post<{ Params: { campaign_id: string } }>('/api/dialer/campaigns/:campaign_id/start', { preHandler: requireAuth }, transition('start'));
  app.post<{ Params: { campaign_id: string } }>('/api/dialer/campaigns/:campaign_id/pause', { preHandler: requireAuth }, transition('pause'));
  app.post<{ Params: { campaign_id: string } }>('/api/dialer/campaigns/:campaign_id/resume', { preHandler: requireAuth }, transition('resume'));
  app.post<{ Params: { campaign_id: string } }>('/api/dialer/campaigns/:campaign_id/cancel', { preHandler: requireAuth }, transition('cancel'));
}
