/**
 * hdk-scanner per P5 PRD §5.11 / DataModel §12.
 * Barcode + QR + document scanning. Depends on hdk-camera (P4).
 *
 * P5 scope: TS facade + server route only. iOS Swift + Android Kotlin
 * natives are a separate workstream (same deferral as P3 HDK natives).
 * Edit events emit hdk-scanner.code.captured.v1 so hdk-sync's conflict resolver picks
 * the right strategy (event-sourcing for image/video, lww for scanner).
 */
import type { FastifyInstance } from 'fastify';
import { requireAuth } from '@projexlight/sdk-identity';
import { appendAuditEntry } from '@projexlight/sdk-audit';

const AUDIT_POOL = process.env.HDK_SCANNER_AUDIT_POOL || 'admin-default';

export async function registerRoutes(app: FastifyInstance): Promise<void> {
  app.post('/api/hdk-scanner/captures', { preHandler: requireAuth }, async (req, reply) => {
    const body = (req.body ?? {}) as Record<string, any>;
    if (!body.device_uuid) {
      return reply.code(400).send({ error: 'ValidationError', details: ['missing device_uuid'] });
    }

    try {
      await appendAuditEntry({
        pool_index: AUDIT_POOL,
        event_type: 'hdk-scanner.code.captured.v1',
        actor_kind: 'service',
        actor_id: 'hdk-scanner.edit',
        subject_kind: 'media.blob',
        subject_id: (body.blob_id as string) ?? body.device_uuid,
        retention_class: 'operational',
        payload: body,
      });
    } catch (err) {
      console.error('[hdk-scanner] audit emit failed', (err as Error).message);
    }
    return reply.code(202).send({ data: { queued: true, event_type: 'hdk-scanner.code.captured.v1' } });
  });
}

export const server = { registerRoutes };
export default { server };
