/**
 * hdk-video-editor per P5 PRD §5.11 / DataModel §12.
 * Trim / compress / watermark. Edits append to media.blob.edit_history.
 *
 * P5 scope: TS facade + server route only. iOS Swift + Android Kotlin
 * natives are a separate workstream (same deferral as P3 HDK natives).
 * Edit events emit hdk-video.trim.applied.v1 so hdk-sync's conflict resolver picks
 * the right strategy (event-sourcing for image/video, lww for scanner).
 */
import type { FastifyInstance } from 'fastify';
import { requireAuth } from '@projexlight/sdk-identity';
import { appendAuditEntry } from '@projexlight/sdk-audit';
import { appendEditOp } from '@projexlight/sdk-media';

const AUDIT_POOL = process.env.HDK_VIDEO_EDITOR_AUDIT_POOL || 'admin-default';

export async function registerRoutes(app: FastifyInstance): Promise<void> {
  app.post('/api/hdk-video/edits', { preHandler: requireAuth }, async (req, reply) => {
    const body = (req.body ?? {}) as Record<string, any>;
    if (!body.device_uuid) {
      return reply.code(400).send({ error: 'ValidationError', details: ['missing device_uuid'] });
    }
  if (body.blob_id && body.op) {
    try { await appendEditOp(body.blob_id, body.op); } catch (err) {
      console.error('[hdk-video-editor] appendEditOp failed', (err as Error).message);
    }
  }

    try {
      await appendAuditEntry({
        pool_index: AUDIT_POOL,
        event_type: 'hdk-video.trim.applied.v1',
        actor_kind: 'service',
        actor_id: 'hdk-video-editor.edit',
        subject_kind: 'media.blob',
        subject_id: (body.blob_id as string) ?? body.device_uuid,
        retention_class: 'operational',
        payload: body,
      });
    } catch (err) {
      console.error('[hdk-video-editor] audit emit failed', (err as Error).message);
    }
    return reply.code(202).send({ data: { queued: true, event_type: 'hdk-video.trim.applied.v1' } });
  });
}

export const server = { registerRoutes };
export default { server };
