import type { FastifyInstance, FastifyPluginCallback } from 'fastify';
import {
  recordCrash,
  recordHealth,
  recordSessionReplay,
  getCrash,
  listCrashesForDevice,
  getLatestHealthForDevice,
} from '../services/intakeService';

/**
 * HTTP surface for sdk-diagnostic-telemetry (P7 §5.6 / AC-5).
 *
 *   POST /api/diagnostic/crash          — crash snapshot intake
 *   POST /api/diagnostic/health         — periodic health probe intake
 *   POST /api/diagnostic/session-replay — sanitized replay event intake
 *   GET  /api/diagnostic/crash/:id      — fetch one crash
 *   GET  /api/diagnostic/crash?device_uuid=…  — list crashes per device
 *   GET  /api/diagnostic/health?device_uuid=… — latest snapshot for device
 */
export const registerRoutes: FastifyPluginCallback = (app: FastifyInstance, _opts, done) => {
  app.post<{
    Body: {
      device_uuid?: string;
      person_id?: string | null;
      app_version?: string;
      os_version?: string;
      stack_envelope?: string;
      occurred_at?: string;
      tenant_id?: string | null;
    };
  }>('/api/diagnostic/crash', async (req, reply) => {
    const b = req.body ?? {};
    if (!b.device_uuid || !b.app_version || !b.os_version || !b.stack_envelope || !b.occurred_at) {
      return reply.code(400).send({
        success: false,
        error: 'device_uuid, app_version, os_version, stack_envelope, occurred_at are required',
      });
    }
    try {
      const data = await recordCrash({
        device_uuid: b.device_uuid,
        person_id: b.person_id ?? null,
        app_version: b.app_version,
        os_version: b.os_version,
        stack_envelope: b.stack_envelope,
        occurred_at: b.occurred_at,
        tenant_id: b.tenant_id ?? null,
      });
      return reply.code(201).send({ success: true, data });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return reply.code(400).send({ success: false, error: msg });
    }
  });

  app.post<{
    Body: {
      device_uuid?: string;
      permissions?: Record<string, boolean>;
      battery_pct?: number | null;
      wifi_state?: string | null;
      sensor_state?: Record<string, unknown>;
      captured_at?: string;
      tenant_id?: string | null;
    };
  }>('/api/diagnostic/health', async (req, reply) => {
    const b = req.body ?? {};
    if (!b.device_uuid || !b.captured_at) {
      return reply.code(400).send({
        success: false,
        error: 'device_uuid and captured_at are required',
      });
    }
    try {
      const data = await recordHealth({
        device_uuid: b.device_uuid,
        permissions: b.permissions,
        battery_pct: b.battery_pct ?? null,
        wifi_state: b.wifi_state ?? null,
        sensor_state: b.sensor_state,
        captured_at: b.captured_at,
        tenant_id: b.tenant_id ?? null,
      });
      return reply.code(201).send({ success: true, data });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return reply.code(400).send({ success: false, error: msg });
    }
  });

  app.post<{
    Body: {
      device_uuid?: string;
      sanitized_event_kind?: string;
      payload?: Record<string, unknown>;
      occurred_at?: string;
    };
  }>('/api/diagnostic/session-replay', async (req, reply) => {
    const b = req.body ?? {};
    if (!b.device_uuid || !b.sanitized_event_kind || !b.occurred_at) {
      return reply.code(400).send({
        success: false,
        error: 'device_uuid, sanitized_event_kind, occurred_at are required',
      });
    }
    try {
      const data = await recordSessionReplay({
        device_uuid: b.device_uuid,
        sanitized_event_kind: b.sanitized_event_kind,
        payload: b.payload,
        occurred_at: b.occurred_at,
      });
      return reply.code(201).send({ success: true, data });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return reply.code(400).send({ success: false, error: msg });
    }
  });

  app.get<{ Params: { id: string } }>('/api/diagnostic/crash/:id', async (req, reply) => {
    const data = await getCrash(req.params.id);
    if (!data) return reply.code(404).send({ success: false, error: 'not found' });
    return { success: true, data };
  });

  app.get<{ Querystring: { device_uuid?: string } }>('/api/diagnostic/crash', async (req, reply) => {
    const deviceUuid = req.query?.device_uuid;
    if (!deviceUuid) {
      return reply.code(400).send({ success: false, error: 'device_uuid query param required' });
    }
    return { success: true, data: await listCrashesForDevice(deviceUuid) };
  });

  app.get<{ Querystring: { device_uuid?: string } }>('/api/diagnostic/health', async (req, reply) => {
    const deviceUuid = req.query?.device_uuid;
    if (!deviceUuid) {
      return reply.code(400).send({ success: false, error: 'device_uuid query param required' });
    }
    const data = await getLatestHealthForDevice(deviceUuid);
    if (!data) return reply.code(404).send({ success: false, error: 'no snapshots recorded' });
    return { success: true, data };
  });

  done();
};
