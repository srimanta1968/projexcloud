import type { FastifyInstance, FastifyPluginCallback } from 'fastify';
import {
  recordMeasurement,
  getMeasurement,
  listMeasurementsForCapture,
} from '../services/measurementService';

/**
 * HTTP surface for hdk-measure (P7 §5.9 / AC-10).
 *
 *   POST /api/hdk/measure          — record a measurement (HDK device intake)
 *   GET  /api/hdk/measure/:id      — fetch one measurement by id
 *   GET  /api/hdk/measure?capture_id=…  — list measurements for a capture
 *
 * AuthN/AuthZ for the intake call lives in api-gateway middleware (the
 * standard JWT + capability-token flow). This module just validates the
 * payload and delegates to the service.
 */
export const registerRoutes: FastifyPluginCallback = (app: FastifyInstance, _opts, done) => {
  app.post<{
    Body: {
      capture_id?: string;
      kind?: 'area' | 'distance' | 'volume';
      value?: number;
      unit?: string;
      accuracy_class?: 'high' | 'medium' | 'low';
      device_uuid?: string;
      captured_at?: string;
      tenant_id?: string | null;
    };
  }>('/api/hdk/measure', async (req, reply) => {
    const body = req.body ?? {};
    if (!body.capture_id || !body.kind || body.value == null || !body.unit || !body.device_uuid) {
      return reply.code(400).send({
        success: false,
        error: 'capture_id, kind, value, unit, device_uuid are required',
      });
    }
    try {
      const data = await recordMeasurement({
        capture_id: body.capture_id,
        kind: body.kind,
        value: body.value,
        unit: body.unit,
        accuracy_class: body.accuracy_class,
        device_uuid: body.device_uuid,
        captured_at: body.captured_at,
        tenant_id: body.tenant_id ?? null,
      });
      return reply.code(201).send({ success: true, data });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return reply.code(400).send({ success: false, error: msg });
    }
  });

  app.get<{ Params: { id: string } }>('/api/hdk/measure/:id', async (req, reply) => {
    const data = await getMeasurement(req.params.id);
    if (!data) return reply.code(404).send({ success: false, error: 'not found' });
    return { success: true, data };
  });

  app.get<{ Querystring: { capture_id?: string } }>('/api/hdk/measure', async (req, reply) => {
    const captureId = req.query?.capture_id;
    if (!captureId) {
      return reply.code(400).send({ success: false, error: 'capture_id query param required' });
    }
    return { success: true, data: await listMeasurementsForCapture(captureId) };
  });

  done();
};
