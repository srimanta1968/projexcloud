import { ingestBatch, type IngestMode } from './service';

/**
 * Minimal route registrar (TK-3468). Kept framework-agnostic (no hard fastify
 * dep) — the gateway calls registerIngestRoutes(app) with its fastify instance.
 * Mounts POST /api/ingest/:entity/batch.
 */
interface RouteApp {
  post(
    path: string,
    handler: (req: IngestRequest, reply: IngestReply) => Promise<unknown>,
  ): void;
}
interface IngestRequest {
  params?: { entity?: string };
  body?: { mode?: IngestMode; idempotency_key?: string; records?: Array<Record<string, unknown>> };
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
}
