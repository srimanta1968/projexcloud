import { FastifyInstance } from 'fastify';
import { requireAuth } from '@projexlight/sdk-identity';
import {
  provisionTrackingNumber,
  listTrackingNumbers,
  releaseTrackingNumber,
  NumberAlreadyProvisioned,
} from '../services/numberService';
import { placeCall, getCall, listCalls, NoCallerIdAvailable } from '../services/callService';
import { TwilioVoiceProviderError } from '../provider';

/**
 * HTTP surface for connector-twilio-voice (P15·E4, TK-3652): tracking-number
 * provisioning and outbound call placement. Every route requires a tenant JWT
 * and is tenant-scoped. The Twilio-facing webhooks are PUBLIC and live in
 * webhookRoutes (TK-3653) — they authenticate by signature, not by JWT.
 */
export async function registerRoutes(app: FastifyInstance): Promise<void> {
  // Provision a tracking number for the tenant.
  app.post('/api/voice/tracking-numbers', { preHandler: requireAuth }, async (req, reply) => {
    const body = (req.body ?? {}) as {
      tenant_id?: string; install_id?: string; phone_number?: string;
      friendly_name?: string; purpose?: string; assigned_persona_id?: string; area_code?: string;
    };
    if (!body.tenant_id || !body.install_id) {
      return reply.code(400).send({ error: 'ValidationError', details: ['tenant_id and install_id are required'] });
    }
    try {
      const tracking_number = await provisionTrackingNumber({
        install_id: body.install_id,
        tenant_id: body.tenant_id,
        phone_number: body.phone_number ?? '',
        friendly_name: body.friendly_name ?? null,
        purpose: body.purpose ?? null,
        assigned_persona_id: body.assigned_persona_id ?? null,
        area_code: body.area_code ?? null,
      });
      return reply.code(201).send({ data: { tracking_number } });
    } catch (err) {
      if (err instanceof NumberAlreadyProvisioned) {
        return reply.code(409).send({ error: 'NumberAlreadyProvisioned', message: err.message });
      }
      if (err instanceof TwilioVoiceProviderError) {
        return reply.code(422).send({ error: 'ProviderError', message: err.message, remediation: err.remediation });
      }
      throw err;
    }
  });

  app.get<{ Querystring: { tenant_id?: string; status?: string; limit?: string; offset?: string } }>(
    '/api/voice/tracking-numbers', { preHandler: requireAuth }, async (req, reply) => {
      if (!req.query.tenant_id) return reply.code(400).send({ error: 'ValidationError', details: ['tenant_id query param required'] });
      const tracking_numbers = await listTrackingNumbers(req.query.tenant_id, {
        status: req.query.status,
        limit: req.query.limit ? Number(req.query.limit) : undefined,
        offset: req.query.offset ? Number(req.query.offset) : undefined,
      });
      return reply.code(200).send({ data: { tracking_numbers } });
    },
  );

  // Release a number back to Twilio; the row is retained as 'released' so past
  // calls stay attributable.
  app.post<{ Params: { tracking_number_id: string } }>(
    '/api/voice/tracking-numbers/:tracking_number_id/release', { preHandler: requireAuth }, async (req, reply) => {
      const body = (req.body ?? {}) as { tenant_id?: string };
      if (!body.tenant_id) return reply.code(400).send({ error: 'ValidationError', details: ['tenant_id is required'] });
      try {
        const tracking_number = await releaseTrackingNumber(body.tenant_id, req.params.tracking_number_id);
        if (!tracking_number) return reply.code(404).send({ error: 'NotFound' });
        return reply.code(200).send({ data: { tracking_number } });
      } catch (err) {
        if (err instanceof TwilioVoiceProviderError) {
          return reply.code(422).send({ error: 'ProviderError', message: err.message, remediation: err.remediation });
        }
        throw err;
      }
    },
  );

  // Place an outbound call (statusCallback + recording + AMD requested).
  app.post('/api/voice/calls', { preHandler: requireAuth }, async (req, reply) => {
    const body = (req.body ?? {}) as {
      tenant_id?: string; install_id?: string; to_number?: string; from_number?: string;
      tracking_number_id?: string; subject_persona_id?: string; initiated_by_persona_id?: string;
      record?: boolean; machine_detection?: boolean; metadata?: Record<string, unknown>;
    };
    if (!body.tenant_id || !body.install_id || !body.to_number) {
      return reply.code(400).send({ error: 'ValidationError', details: ['tenant_id, install_id and to_number are required'] });
    }
    try {
      const call = await placeCall({
        install_id: body.install_id,
        tenant_id: body.tenant_id,
        to_number: body.to_number,
        from_number: body.from_number ?? null,
        tracking_number_id: body.tracking_number_id ?? null,
        subject_persona_id: body.subject_persona_id ?? null,
        initiated_by_persona_id: body.initiated_by_persona_id ?? null,
        record: body.record,
        machine_detection: body.machine_detection,
        metadata: body.metadata,
      });
      return reply.code(201).send({ data: { call } });
    } catch (err) {
      if (err instanceof NoCallerIdAvailable) {
        return reply.code(400).send({ error: 'NoCallerIdAvailable', message: err.message });
      }
      if (err instanceof TwilioVoiceProviderError) {
        return reply.code(422).send({ error: 'ProviderError', message: err.message, remediation: err.remediation });
      }
      throw err;
    }
  });

  app.get<{ Querystring: { tenant_id?: string; status?: string; direction?: string; is_voicemail?: string; limit?: string; offset?: string } }>(
    '/api/voice/calls', { preHandler: requireAuth }, async (req, reply) => {
      if (!req.query.tenant_id) return reply.code(400).send({ error: 'ValidationError', details: ['tenant_id query param required'] });
      const calls = await listCalls(req.query.tenant_id, {
        status: req.query.status,
        direction: req.query.direction,
        is_voicemail: req.query.is_voicemail === undefined ? undefined : req.query.is_voicemail === 'true',
        limit: req.query.limit ? Number(req.query.limit) : undefined,
        offset: req.query.offset ? Number(req.query.offset) : undefined,
      });
      return reply.code(200).send({ data: { calls } });
    },
  );

  app.get<{ Params: { voice_call_id: string }; Querystring: { tenant_id?: string } }>(
    '/api/voice/calls/:voice_call_id', { preHandler: requireAuth }, async (req, reply) => {
      if (!req.query.tenant_id) return reply.code(400).send({ error: 'ValidationError', details: ['tenant_id query param required'] });
      const call = await getCall(req.query.tenant_id, req.params.voice_call_id);
      if (!call) return reply.code(404).send({ error: 'NotFound' });
      return reply.code(200).send({ data: { call } });
    },
  );
}
