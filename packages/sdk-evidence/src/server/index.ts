import type { FastifyInstance, FastifyPluginCallback } from 'fastify';
import {
  captureEvidence,
  getCapture,
  listCapturesForEncounter,
} from '../services/captureIntake';
import { EncounterSealedError } from '../services/sealGuard';

/**
 * HTTP surface for sdk-evidence intake (P7 §5.5 / AC-1).
 *
 *   POST /api/evidence/capture            — provenance-stamped intake
 *   GET  /api/evidence/capture/:id        — fetch a capture
 *   GET  /api/evidence/capture?encounter_id=…  — list captures per encounter
 *
 * EncounterSealedError → 409 Conflict so the client knows the encounter
 * was sealed between upload and intake (this is the canonical AC-11 path).
 */
export const registerRoutes: FastifyPluginCallback = (app: FastifyInstance, _opts, done) => {
  app.post<{
    Body: {
      tenant_id?: string;
      encounter_id?: string;
      capturer_persona_id?: string;
      device_uuid?: string;
      device_attestation_id?: string;
      raw_blob_id?: string;
      blob_checksum?: string;
      captured_at?: string;
      lat?: number | null;
      lng?: number | null;
      altitude?: number | null;
      imu_signature?: string | null;
      consent_ref?: string;
      retention_class?: string;
      retention_expires_at?: string | null;
    };
  }>('/api/evidence/capture', async (req, reply) => {
    const b = req.body ?? {};
    const required: Array<keyof typeof b> = [
      'tenant_id',
      'encounter_id',
      'capturer_persona_id',
      'device_uuid',
      'device_attestation_id',
      'raw_blob_id',
      'blob_checksum',
      'consent_ref',
      'captured_at',
    ];
    const missing = required.filter((k) => !b[k]);
    if (missing.length > 0) {
      return reply.code(400).send({
        success: false,
        error: `missing required fields: ${missing.join(', ')}`,
      });
    }
    try {
      const data = await captureEvidence({
        tenant_id: b.tenant_id!,
        encounter_id: b.encounter_id!,
        capturer_persona_id: b.capturer_persona_id!,
        device_uuid: b.device_uuid!,
        device_attestation_id: b.device_attestation_id!,
        raw_blob_id: b.raw_blob_id!,
        blob_checksum: b.blob_checksum!,
        captured_at: b.captured_at!,
        consent_ref: b.consent_ref!,
        lat: b.lat ?? null,
        lng: b.lng ?? null,
        altitude: b.altitude ?? null,
        imu_signature: b.imu_signature ?? null,
        retention_class: b.retention_class,
        retention_expires_at: b.retention_expires_at ?? null,
      });
      return reply.code(201).send({ success: true, data });
    } catch (err) {
      if (err instanceof EncounterSealedError) {
        return reply.code(err.status_code).send({
          success: false,
          error: err.message,
          code: err.code,
          encounter_id: err.encounter_id,
          sealed_at: err.sealed_at,
        });
      }
      const msg = err instanceof Error ? err.message : String(err);
      return reply.code(400).send({ success: false, error: msg });
    }
  });

  app.get<{ Params: { id: string } }>('/api/evidence/capture/:id', async (req, reply) => {
    const data = await getCapture(req.params.id);
    if (!data) return reply.code(404).send({ success: false, error: 'not found' });
    return { success: true, data };
  });

  app.get<{ Querystring: { encounter_id?: string } }>('/api/evidence/capture', async (req, reply) => {
    const encounterId = req.query?.encounter_id;
    if (!encounterId) {
      return reply.code(400).send({ success: false, error: 'encounter_id query param required' });
    }
    return { success: true, data: await listCapturesForEncounter(encounterId) };
  });

  done();
};
