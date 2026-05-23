import { FastifyInstance } from 'fastify';
import { requireAuth } from '@projexlight/sdk-identity';
import {
  listShredHistory,
  readBand,
  readSecureData,
  setSecureField,
  shredSecureField,
  upsertBand,
} from '../services/profileService';
import type { BandKind, ShredReason } from '../models/profile.model';

const BAND_KINDS: BandKind[] = ['profile', 'preference', 'notification_routing'];
const SHRED_REASONS: ShredReason[] = ['retention-expiry', 'dsar-erasure', 'operator-request'];

export async function registerRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Params: { app_identity_id: string; band_kind: string } }>(
    '/api/profile/bands/:app_identity_id/:band_kind',
    { preHandler: requireAuth },
    async (req, reply) => {
      const { app_identity_id, band_kind } = req.params;
      if (!BAND_KINDS.includes(band_kind as BandKind)) {
        return reply.code(400).send({ error: 'ValidationError', details: ['invalid band_kind'] });
      }
      const band = await readBand(app_identity_id, band_kind as BandKind);
      if (!band) return reply.code(404).send({ error: 'NotFound' });
      return reply.code(200).send({ data: { band } });
    },
  );

  app.put('/api/profile/bands', { preHandler: requireAuth }, async (req, reply) => {
    const body = req.body as Partial<{
      app_identity_id: string;
      band_kind: BandKind;
      tenant_id: string;
      fields_envelope: Record<string, string>;
    }>;
    if (!body.app_identity_id || !body.band_kind || !body.tenant_id) {
      return reply.code(400).send({ error: 'ValidationError', details: ['missing required fields'] });
    }
    if (!BAND_KINDS.includes(body.band_kind)) {
      return reply.code(400).send({ error: 'ValidationError', details: ['invalid band_kind'] });
    }
    const band = await upsertBand({
      app_identity_id: body.app_identity_id,
      band_kind: body.band_kind,
      tenant_id: body.tenant_id,
      fields_envelope: body.fields_envelope ?? {},
    });
    return reply.code(200).send({ data: { band } });
  });

  app.get<{ Params: { person_id: string } }>(
    '/api/profile/secure-data/:person_id',
    { preHandler: requireAuth },
    async (req, reply) => {
      const record = await readSecureData(req.params.person_id);
      if (!record) return reply.code(404).send({ error: 'NotFound' });
      return reply.code(200).send({ data: { secure_data: record } });
    },
  );

  app.post('/api/profile/secure-data/set-field', { preHandler: requireAuth }, async (req, reply) => {
    const body = req.body as Partial<{ person_id: string; field_name: string; envelope: string }>;
    if (!body.person_id || !body.field_name || !body.envelope) {
      return reply.code(400).send({ error: 'ValidationError', details: ['missing required fields'] });
    }
    const record = await setSecureField({
      person_id: body.person_id,
      field_name: body.field_name,
      envelope: body.envelope,
    });
    return reply.code(200).send({ data: { secure_data: record } });
  });

  app.post('/api/profile/secure-data/shred-field', { preHandler: requireAuth }, async (req, reply) => {
    const body = req.body as Partial<{
      person_id: string;
      field_name: string;
      reason: ShredReason;
      audit_entry_id: string;
    }>;
    if (!body.person_id || !body.field_name || !body.reason) {
      return reply.code(400).send({ error: 'ValidationError', details: ['missing required fields'] });
    }
    if (!SHRED_REASONS.includes(body.reason)) {
      return reply.code(400).send({ error: 'ValidationError', details: ['invalid reason'] });
    }
    const log = await shredSecureField({
      person_id: body.person_id,
      field_name: body.field_name,
      reason: body.reason,
      audit_entry_id: body.audit_entry_id,
    });
    return reply.code(200).send({ data: { shred: log } });
  });

  app.get<{ Params: { person_id: string } }>(
    '/api/profile/secure-data/:person_id/shred-history',
    { preHandler: requireAuth },
    async (req, reply) => {
      const history = await listShredHistory(req.params.person_id);
      return reply.code(200).send({ data: { history } });
    },
  );
}
