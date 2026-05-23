import { FastifyInstance } from 'fastify';
import { requireAuth } from '@projexlight/sdk-identity';
import {
  attestDevice,
  getDevice,
  linkPerson,
  listDevicesForPerson,
  listPersonsForDevice,
  registerDevice,
  revokeDevice,
} from '../services/deviceService';
import type { AttestationMethod, DevicePlatform } from '../models/device.model';

const PLATFORMS: DevicePlatform[] = ['ios', 'android', 'web', 'desktop'];
const METHODS: AttestationMethod[] = ['secure-enclave', 'key-attestation', 'safetynet', 'play-integrity'];

export async function registerRoutes(app: FastifyInstance): Promise<void> {
  app.post('/api/devices', { preHandler: requireAuth }, async (req, reply) => {
    const body = req.body as Partial<{
      device_uuid: string;
      platform: DevicePlatform;
      os_version: string;
      app_version: string;
      device_key_ref: string;
    }>;
    if (!body.device_uuid || !body.platform) {
      return reply.code(400).send({ error: 'ValidationError', details: ['missing fields'] });
    }
    if (!PLATFORMS.includes(body.platform)) {
      return reply.code(400).send({ error: 'ValidationError', details: ['invalid platform'] });
    }
    const record = await registerDevice({
      device_uuid: body.device_uuid,
      platform: body.platform,
      os_version: body.os_version,
      app_version: body.app_version,
      device_key_ref: body.device_key_ref,
    });
    return reply.code(201).send({ data: { device: record } });
  });

  app.get<{ Params: { device_uuid: string } }>(
    '/api/devices/:device_uuid',
    { preHandler: requireAuth },
    async (req, reply) => {
      const record = await getDevice(req.params.device_uuid);
      if (!record) return reply.code(404).send({ error: 'NotFound' });
      return reply.code(200).send({ data: { device: record } });
    },
  );

  app.post<{ Params: { device_uuid: string } }>(
    '/api/devices/:device_uuid/attest',
    { preHandler: requireAuth },
    async (req, reply) => {
      const body = req.body as Partial<{
        method: AttestationMethod;
        signature_envelope: string;
        expires_at: string;
        verified: boolean;
      }>;
      if (!body.method || !body.signature_envelope) {
        return reply.code(400).send({ error: 'ValidationError', details: ['missing fields'] });
      }
      if (!METHODS.includes(body.method)) {
        return reply.code(400).send({ error: 'ValidationError', details: ['invalid method'] });
      }
      const record = await attestDevice({
        device_uuid: req.params.device_uuid,
        method: body.method,
        signature_envelope: body.signature_envelope,
        expires_at: body.expires_at,
        verified: body.verified,
      });
      return reply.code(201).send({ data: { attestation: record } });
    },
  );

  app.post<{ Params: { device_uuid: string } }>(
    '/api/devices/:device_uuid/revoke',
    { preHandler: requireAuth },
    async (req, reply) => {
      const body = req.body as Partial<{ reason: 'revoked' | 'stolen' }>;
      const record = await revokeDevice(req.params.device_uuid, body.reason);
      if (!record) return reply.code(404).send({ error: 'NotFound' });
      return reply.code(200).send({ data: { device: record } });
    },
  );

  app.post<{ Params: { device_uuid: string } }>(
    '/api/devices/:device_uuid/link-person',
    { preHandler: requireAuth },
    async (req, reply) => {
      const body = req.body as Partial<{ person_id: string }>;
      if (!body.person_id) {
        return reply.code(400).send({ error: 'ValidationError', details: ['missing person_id'] });
      }
      const record = await linkPerson({ device_uuid: req.params.device_uuid, person_id: body.person_id });
      return reply.code(200).send({ data: { link: record } });
    },
  );

  app.get<{ Params: { device_uuid: string } }>(
    '/api/devices/:device_uuid/persons',
    { preHandler: requireAuth },
    async (req, reply) => {
      const records = await listPersonsForDevice(req.params.device_uuid);
      return reply.code(200).send({ data: { links: records } });
    },
  );

  app.get<{ Params: { person_id: string } }>(
    '/api/persons/:person_id/devices',
    { preHandler: requireAuth },
    async (req, reply) => {
      const records = await listDevicesForPerson(req.params.person_id);
      return reply.code(200).send({ data: { links: records } });
    },
  );
}
