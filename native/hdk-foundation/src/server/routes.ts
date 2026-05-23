import { FastifyInstance } from 'fastify';
import { requireAuth } from '@projexlight/sdk-identity';
import {
  listClaimsForDevice,
  logOfflineAuth,
  registerClaim,
} from '../services/hdkIdpService';
import { latestSnapshot, snapshotSurface } from '../services/hdkPermissionsService';
import { captureEvent, drainQueue } from '../services/hdkDiagnosticService';
import type { OfflineAuthMethod } from '../models/foundation.model';

const AUTH_METHODS: OfflineAuthMethod[] = ['biometric', 'pin', 'passkey'];

export async function registerRoutes(app: FastifyInstance): Promise<void> {
  // hdk-idp ---------------------------------------------------------------
  app.post('/api/hdk-idp/claims', { preHandler: requireAuth }, async (req, reply) => {
    const body = req.body as Partial<{
      device_uuid: string;
      person_id: string;
      biometric_template_envelope: string;
      pin_envelope: string;
    }>;
    if (!body.device_uuid || !body.person_id) {
      return reply.code(400).send({ error: 'ValidationError', details: ['missing fields'] });
    }
    const record = await registerClaim({
      device_uuid: body.device_uuid,
      person_id: body.person_id,
      biometric_template_envelope: body.biometric_template_envelope,
      pin_envelope: body.pin_envelope,
    });
    return reply.code(201).send({ data: { claim: record } });
  });

  app.get<{ Params: { device_uuid: string } }>(
    '/api/hdk-idp/devices/:device_uuid/claims',
    { preHandler: requireAuth },
    async (req, reply) => {
      const records = await listClaimsForDevice(req.params.device_uuid);
      return reply.code(200).send({ data: { claims: records } });
    },
  );

  app.post('/api/hdk-idp/offline-auth/log', { preHandler: requireAuth }, async (req, reply) => {
    const body = req.body as Partial<{
      device_uuid: string;
      person_id: string;
      method: OfflineAuthMethod;
      occurred_at: string;
    }>;
    if (!body.device_uuid || !body.person_id || !body.method || !body.occurred_at) {
      return reply.code(400).send({ error: 'ValidationError', details: ['missing fields'] });
    }
    if (!AUTH_METHODS.includes(body.method)) {
      return reply.code(400).send({ error: 'ValidationError', details: ['invalid method'] });
    }
    const record = await logOfflineAuth({
      device_uuid: body.device_uuid,
      person_id: body.person_id,
      method: body.method,
      occurred_at: body.occurred_at,
    });
    return reply.code(201).send({ data: { log: record } });
  });

  // hdk-permissions -------------------------------------------------------
  app.post('/api/hdk-permissions/snapshots', { preHandler: requireAuth }, async (req, reply) => {
    const body = req.body as Partial<{
      device_uuid: string;
      tenant_id: string;
      persona_id: string;
      permission_set: Record<string, boolean | string>;
    }>;
    if (!body.device_uuid || !body.tenant_id || !body.permission_set) {
      return reply.code(400).send({ error: 'ValidationError', details: ['missing fields'] });
    }
    const record = await snapshotSurface({
      device_uuid: body.device_uuid,
      tenant_id: body.tenant_id,
      persona_id: body.persona_id,
      permission_set: body.permission_set,
    });
    return reply.code(201).send({ data: { snapshot: record } });
  });

  app.get<{ Params: { device_uuid: string } }>(
    '/api/hdk-permissions/devices/:device_uuid/latest',
    { preHandler: requireAuth },
    async (req, reply) => {
      const record = await latestSnapshot(req.params.device_uuid);
      if (!record) return reply.code(404).send({ error: 'NotFound' });
      return reply.code(200).send({ data: { snapshot: record } });
    },
  );

  // hdk-diagnostic --------------------------------------------------------
  app.post('/api/hdk-diagnostic/events', { preHandler: requireAuth }, async (req, reply) => {
    const body = req.body as Partial<{
      device_uuid: string;
      category: string;
      payload: Record<string, unknown>;
      occurred_at: string;
    }>;
    if (!body.device_uuid || !body.category) {
      return reply.code(400).send({ error: 'ValidationError', details: ['missing fields'] });
    }
    const result = await captureEvent({
      device_uuid: body.device_uuid,
      category: body.category,
      payload: body.payload ?? {},
      occurred_at: body.occurred_at,
    });
    return reply.code(202).send({ data: result });
  });

  app.post('/api/hdk-diagnostic/drain', { preHandler: requireAuth }, async (req, reply) => {
    const body = (req.body ?? {}) as Partial<{ limit: number }>;
    const events = await drainQueue(body.limit);
    return reply.code(200).send({ data: { events, count: events.length } });
  });
}
