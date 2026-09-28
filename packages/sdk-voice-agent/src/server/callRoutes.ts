import type { FastifyInstance } from 'fastify';
import { requireAuth } from '@projexlight/sdk-identity';
import { getCall, listCalls, placeCall, type PlaceCallInput } from '../services/callService';
import { completeCall, type CompleteCallInput } from '../services/postCallService';
import { resolveTenant } from './tenantScope';
import { sendError } from './sendError';

const num = (v: string | undefined): number | undefined => (v === undefined ? undefined : Number(v));

/** AI call routes (VA·E2 · TK-4474), tenant-scoped through resolveTenant. */
export function registerCallRoutes(app: FastifyInstance): void {
  // 201 when the call is placed now; 200 + Idempotent-Replayed when a retry replays it.
  app.post('/api/voice-agent/calls', { preHandler: requireAuth }, async (req, reply) => {
    const body = (req.body ?? {}) as PlaceCallInput & { tenant_id?: string };
    const tenantId = resolveTenant(req, reply, body.tenant_id);
    if (!tenantId) return reply;
    const header = req.headers['idempotency-key'];
    const idempotencyKey = Array.isArray(header) ? header[0] : header;
    try {
      const { call, replayed } = await placeCall(tenantId, body, {
        idempotencyKey,
        requestedBy: req.auth?.primary_persona_id ?? req.auth?.sub,
      });
      if (replayed) reply.header('Idempotent-Replayed', 'true');
      return reply.code(replayed ? 200 : 201).send({ data: { call, replayed } });
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.get<{ Querystring: { tenant_id?: string; agent_id?: string; status?: string; direction?: string; subject_ref?: string; is_test?: string; limit?: string; offset?: string } }>(
    '/api/voice-agent/calls', { preHandler: requireAuth }, async (req, reply) => {
      const tenantId = resolveTenant(req, reply, req.query.tenant_id);
      if (!tenantId) return reply;
      try {
        const { tenant_id: _t, limit, offset, ...filter } = req.query;
        return reply.code(200).send({ data: await listCalls(tenantId, { ...filter, limit: num(limit), offset: num(offset) }) });
      } catch (err) {
        return sendError(reply, err);
      }
    },
  );

  app.get<{ Params: { call_id: string }; Querystring: { tenant_id?: string } }>(
    '/api/voice-agent/calls/:call_id', { preHandler: requireAuth }, async (req, reply) => {
      const tenantId = resolveTenant(req, reply, req.query.tenant_id);
      if (!tenantId) return reply;
      const call = await getCall(tenantId, req.params.call_id);
      if (!call) return reply.code(404).send({ error: 'NotFound', details: ['call not found'] });
      return reply.code(200).send({ data: { call } });
    },
  );

  // The voice runtime reports the end of a call (turns + outcome); post-call summary and
  // mirroring run here. Repeating the same report is safe.
  app.post<{ Params: { call_id: string } }>(
    '/api/voice-agent/calls/:call_id/complete', { preHandler: requireAuth }, async (req, reply) => {
      const body = (req.body ?? {}) as CompleteCallInput & { tenant_id?: string };
      const tenantId = resolveTenant(req, reply, body.tenant_id);
      if (!tenantId) return reply;
      try {
        const actor = req.auth?.primary_persona_id ?? req.auth?.sub ?? 'unknown';
        return reply.code(200).send({ data: { call: await completeCall(tenantId, req.params.call_id, body, actor) } });
      } catch (err) {
        return sendError(reply, err);
      }
    },
  );
}
