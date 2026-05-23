import { FastifyInstance } from 'fastify';
import { requireAuth } from '@projexlight/sdk-identity';
import {
  completeReplay,
  getEventTypePolicy,
  listEventTypePolicies,
  listOpenHumanReviewTasks,
  registerEventTypePolicy,
  resolveConflict,
  resolveHumanReview,
  startReplay,
} from '../services/hdkSyncService';
import type { ConflictPolicy, RetentionClass, ReviewStatus, SyncEventEnvelope } from '../models/sync.model';

const POLICIES: ConflictPolicy[] = ['crdt', 'lww', 'merge', 'event-sourcing', 'human-review'];
const RETENTIONS: RetentionClass[] = ['transient', 'operational', 'regulated'];
const REVIEW_STATUSES: ReviewStatus[] = ['open', 'in-review', 'resolved', 'rejected'];

export async function registerRoutes(app: FastifyInstance): Promise<void> {
  // Event Type Policy registry ------------------------------------------
  app.put('/api/hdk-sync/event-type-policies', { preHandler: requireAuth }, async (req, reply) => {
    const body = req.body as Partial<{
      event_type: string;
      conflict_policy: ConflictPolicy;
      strategy_detail: string;
      retention_class: RetentionClass;
    }>;
    if (!body.event_type || !body.conflict_policy) {
      return reply.code(400).send({ error: 'ValidationError', details: ['missing fields'] });
    }
    if (!POLICIES.includes(body.conflict_policy)) {
      return reply.code(400).send({ error: 'ValidationError', details: ['invalid conflict_policy'] });
    }
    if (body.retention_class && !RETENTIONS.includes(body.retention_class)) {
      return reply.code(400).send({ error: 'ValidationError', details: ['invalid retention_class'] });
    }
    const record = await registerEventTypePolicy(
      body.event_type,
      body.conflict_policy,
      body.strategy_detail,
      body.retention_class,
    );
    return reply.code(200).send({ data: { policy: record } });
  });

  app.get('/api/hdk-sync/event-type-policies', { preHandler: requireAuth }, async (_req, reply) => {
    const records = await listEventTypePolicies();
    return reply.code(200).send({ data: { policies: records } });
  });

  app.get<{ Params: { event_type: string } }>(
    '/api/hdk-sync/event-type-policies/:event_type',
    { preHandler: requireAuth },
    async (req, reply) => {
      const record = await getEventTypePolicy(req.params.event_type);
      if (!record) return reply.code(404).send({ error: 'NotFound' });
      return reply.code(200).send({ data: { policy: record } });
    },
  );

  // Replay & conflict resolution ----------------------------------------
  app.post('/api/hdk-sync/replay/start', { preHandler: requireAuth }, async (req, reply) => {
    const body = req.body as Partial<{
      device_uuid: string;
      tenant_id: string;
      envelopes: SyncEventEnvelope[];
    }>;
    if (!body.device_uuid || !body.tenant_id || !Array.isArray(body.envelopes)) {
      return reply.code(400).send({ error: 'ValidationError', details: ['missing fields'] });
    }
    const { batch, rejected } = await startReplay(body.device_uuid, body.tenant_id, body.envelopes);
    return reply.code(201).send({ data: { batch, rejected } });
  });

  app.post<{ Params: { batch_id: string } }>(
    '/api/hdk-sync/replay/:batch_id/complete',
    { preHandler: requireAuth },
    async (req, reply) => {
      const body = req.body as Partial<{ conflict_count: number }>;
      const record = await completeReplay(req.params.batch_id, body.conflict_count ?? 0);
      if (!record) return reply.code(404).send({ error: 'NotFound' });
      return reply.code(200).send({ data: { batch: record } });
    },
  );

  app.post('/api/hdk-sync/conflicts/resolve', { preHandler: requireAuth }, async (req, reply) => {
    const body = req.body as Partial<{
      event_type: string;
      input_a: Record<string, unknown>;
      input_b: Record<string, unknown>;
      batch_id: string;
      audit_entry_id: string;
    }>;
    if (!body.event_type || !body.input_a || !body.input_b) {
      return reply.code(400).send({ error: 'ValidationError', details: ['missing fields'] });
    }
    try {
      const result = await resolveConflict(
        {
          event_type: body.event_type,
          input_a: body.input_a,
          input_b: body.input_b,
          batch_id: body.batch_id,
        },
        body.audit_entry_id,
      );
      return reply.code(200).send({ data: result });
    } catch (err) {
      return reply.code(409).send({ error: 'UnregisteredEventType', details: [(err as Error).message] });
    }
  });

  // Human review queue --------------------------------------------------
  app.get('/api/hdk-sync/human-review/open', { preHandler: requireAuth }, async (req, reply) => {
    const query = req.query as Partial<{ assignee_persona_id: string }>;
    const records = await listOpenHumanReviewTasks(query.assignee_persona_id);
    return reply.code(200).send({ data: { tasks: records } });
  });

  app.post<{ Params: { task_id: string } }>(
    '/api/hdk-sync/human-review/:task_id/resolve',
    { preHandler: requireAuth },
    async (req, reply) => {
      const body = req.body as Partial<{
        status: ReviewStatus;
        resolved_value: Record<string, unknown>;
      }>;
      if (!body.status || !REVIEW_STATUSES.includes(body.status)) {
        return reply.code(400).send({ error: 'ValidationError', details: ['invalid status'] });
      }
      const record = await resolveHumanReview(req.params.task_id, body.status, body.resolved_value ?? null);
      if (!record) return reply.code(404).send({ error: 'NotFound' });
      return reply.code(200).send({ data: { task: record } });
    },
  );
}
