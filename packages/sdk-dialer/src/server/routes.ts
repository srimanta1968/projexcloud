import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { requireAuth } from '@projexlight/sdk-identity';
import {
  createCampaign,
  getCampaign,
  isValidTimezone,
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
import { reportAmd } from '../services/amdService';
import { addCallerId, deactivateCallerId, listCallerIds } from '../services/callerIdService';
import { DISPOSITIONS } from '../services/dispositionService';
import { checkCallingWindow } from '../services/windowRecordingGates';
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

  // TK-4507 — may this recipient be called now? The calling_window gate's own verdict: the
  // campaign's window (or the default 08:00-21:00) in the recipient's local time zone(s).
  app.post('/api/dialer/calling-window/check', { preHandler: requireAuth }, async (req, reply) => {
    const body = (req.body ?? {}) as { tenant_id?: string; to_number?: unknown; recipient_timezone?: unknown; campaign_id?: unknown; at?: unknown };
    const tenantId = resolveTenant(req, reply, body.tenant_id);
    if (!tenantId) return reply;
    const details: string[] = [];
    if (typeof body.to_number !== 'string' || !/^\+[1-9][0-9]{6,14}$/.test(body.to_number)) details.push('to_number must be E.164, e.g. +14155550100');
    if (body.recipient_timezone !== undefined && body.recipient_timezone !== null
      && (typeof body.recipient_timezone !== 'string' || !isValidTimezone(body.recipient_timezone))) {
      details.push('recipient_timezone must be an IANA timezone, e.g. America/Chicago');
    }
    if (body.campaign_id !== undefined && body.campaign_id !== null
      && (typeof body.campaign_id !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(body.campaign_id))) {
      details.push('campaign_id must be a uuid');
    }
    const at = body.at === undefined || body.at === null ? new Date() : new Date(String(body.at));
    if (Number.isNaN(at.getTime())) details.push('at must be an ISO-8601 timestamp');
    if (details.length) return reply.code(400).send({ error: 'ValidationError', details });
    if (typeof body.campaign_id === 'string' && !(await getCampaign(tenantId, body.campaign_id))) {
      return reply.code(404).send({ error: 'NotFound', details: ['campaign not found'] });
    }
    const check = await checkCallingWindow({
      tenant_id: tenantId,
      to_number: body.to_number as string,
      timezone: (body.recipient_timezone as string | undefined) ?? null,
      campaign_id: (body.campaign_id as string | undefined) ?? null,
      at,
    });
    return reply.code(200).send({ data: { check } });
  });

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

  // TK-4486 — the carrier's answering-machine result; answers with connect or the voicemail policy.
  app.post<{ Params: { call_id: string } }>('/api/dialer/calls/:call_id/amd', { preHandler: requireAuth }, async (req, reply) => {
    const body = (req.body ?? {}) as { answered_by?: unknown; tenant_id?: string };
    const tenantId = resolveTenant(req, reply, body.tenant_id);
    if (!tenantId) return reply;
    try {
      return reply.code(200).send({ data: { decision: await reportAmd(tenantId, req.params.call_id, body) } });
    } catch (err) {
      return sendError(reply, err);
    }
  });

  // TK-4487 — the tenant's caller-ID pool.
  app.post('/api/dialer/caller-ids', { preHandler: requireAuth }, async (req, reply) => {
    const body = (req.body ?? {}) as { phone_number?: unknown; attestation?: unknown; label?: unknown; tenant_id?: string };
    const tenantId = resolveTenant(req, reply, body.tenant_id);
    if (!tenantId) return reply;
    try {
      return reply.code(201).send({ data: { caller_id: await addCallerId(tenantId, body) } });
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.get<{ Querystring: { tenant_id?: string; active?: string } }>('/api/dialer/caller-ids', { preHandler: requireAuth }, async (req, reply) => {
    const tenantId = resolveTenant(req, reply, req.query.tenant_id);
    if (!tenantId) return reply;
    try {
      return reply.code(200).send({ data: { caller_ids: await listCallerIds(tenantId, { active: req.query.active }) } });
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.post<{ Params: { caller_id_id: string } }>('/api/dialer/caller-ids/:caller_id_id/deactivate', { preHandler: requireAuth }, async (req, reply) => {
    const body = (req.body ?? {}) as { tenant_id?: string };
    const tenantId = resolveTenant(req, reply, body.tenant_id);
    if (!tenantId) return reply;
    try {
      return reply.code(200).send({ data: { caller_id: await deactivateCallerId(tenantId, req.params.caller_id_id) } });
    } catch (err) {
      return sendError(reply, err);
    }
  });

  // TK-4488 — the disposition taxonomy: what each outcome means to the dialer and the CRM.
  app.get('/api/dialer/dispositions', { preHandler: requireAuth }, async (_req, reply) => {
    return reply.code(200).send({ data: { dispositions: DISPOSITIONS } });
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
