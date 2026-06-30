import { ingestBatch, ingestSensorReadingsBatch, type IngestMode, type SensorReadingInput } from './service';

/**
 * Minimal route registrar (TK-3468). Kept framework-agnostic (no hard fastify
 * dep) — the gateway calls registerIngestRoutes(app) with its fastify instance.
 * Mounts:
 *   POST /api/ingest/:entity/batch          — generic ETL landing
 *   POST /api/ingest/sensor-readings/batch  — typed sensor time-series (P12)
 */
interface RouteApp {
  post(
    path: string,
    handler: (req: IngestRequest, reply: IngestReply) => Promise<unknown>,
  ): void;
}
interface IngestRequest {
  params?: { entity?: string };
  body?: {
    mode?: IngestMode;
    idempotency_key?: string;
    records?: Array<Record<string, unknown>>;
    readings?: SensorReadingInput[];
    tenant_id?: string;
  };
  auth?: { tenant?: string };
}
interface IngestReply {
  code(status: number): IngestReply;
}

export function registerIngestRoutes(app: RouteApp): void {
  app.post('/api/ingest/:entity/batch', async (req, reply) => {
    const entity = req.params?.entity ?? '';
    const body = req.body ?? {};
    try {
      return await ingestBatch({
        entity,
        mode: body.mode,
        idempotency_key: body.idempotency_key ?? '',
        records: body.records ?? [],
        tenant_id: req.auth?.tenant,
      });
    } catch (err) {
      reply.code(400);
      return { error: (err as Error).message };
    }
  });

  app.post('/api/ingest/sensor-readings/batch', async (req, reply) => {
    const body = req.body ?? {};
    try {
      const data = await ingestSensorReadingsBatch({
        idempotency_key: body.idempotency_key ?? '',
        readings: body.readings ?? [],
        tenant_id: req.auth?.tenant ?? body.tenant_id,
      });
      reply.code(201);
      return { success: true, data };
    } catch (err) {
      reply.code(400);
      return { success: false, error: (err as Error).message };
    }
  });
}
