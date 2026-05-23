import { dataService } from '@projexlight/db-runtime';
import { appendAuditEntry } from '@projexlight/sdk-audit';
import type {
  ConflictPolicy,
  ConflictRecord,
  EventTypePolicy,
  HumanReviewTaskRecord,
  ReplayLogRecord,
  ResolveConflictInput,
  ResolveConflictResult,
  RetentionClass,
  ReviewStatus,
  SyncEventEnvelope,
} from '../models/sync.model';
import { resolveByPolicy } from './conflictResolver';

const HDK_SYNC_AUDIT_POOL = process.env.HDK_SYNC_AUDIT_POOL || 'admin-default';

/**
 * hdk-sync service — server-side reconciler + Conflict Resolution Model.
 * P3 PRD §5.8 / FR-HS-1..7. G6 closer.
 */

export async function registerEventTypePolicy(
  event_type: string,
  conflict_policy: ConflictPolicy,
  strategy_detail?: string,
  retention_class: RetentionClass = 'operational',
): Promise<EventTypePolicy> {
  const rows = await dataService.rows<EventTypePolicy>(
    `INSERT INTO hdk_sync.event_type_policy
       (event_type, conflict_policy, strategy_detail, retention_class)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (event_type) DO UPDATE SET
       conflict_policy = EXCLUDED.conflict_policy,
       strategy_detail = EXCLUDED.strategy_detail,
       retention_class = EXCLUDED.retention_class
     RETURNING event_type, conflict_policy, strategy_detail, retention_class, registered_at`,
    [event_type, conflict_policy, strategy_detail ?? null, retention_class],
  );
  return rows[0];
}

export async function getEventTypePolicy(event_type: string): Promise<EventTypePolicy | null> {
  return dataService.one<EventTypePolicy>(
    `SELECT event_type, conflict_policy, strategy_detail, retention_class, registered_at
       FROM hdk_sync.event_type_policy WHERE event_type = $1`,
    [event_type],
  );
}

export async function listEventTypePolicies(): Promise<EventTypePolicy[]> {
  return dataService.rows<EventTypePolicy>(
    `SELECT event_type, conflict_policy, strategy_detail, retention_class, registered_at
       FROM hdk_sync.event_type_policy ORDER BY event_type`,
  );
}

/**
 * Open a replay batch and ingest the device's envelope set. The reconciler
 * walks the batch and resolves any conflicts via resolveConflict() below.
 *
 * AC-13: any event whose event_type is not registered in event_type_policy is
 * rejected at the gateway. This protects the Conflict Resolution Model
 * doctrine — if there's no policy declared, we don't know how to resolve.
 */
export async function startReplay(
  device_uuid: string,
  tenant_id: string,
  envelopes: SyncEventEnvelope[],
): Promise<{ batch: ReplayLogRecord; rejected: SyncEventEnvelope[] }> {
  const policies = await listEventTypePolicies();
  const registered = new Set(policies.map((p) => p.event_type));
  const rejected = envelopes.filter((e) => !registered.has(e.event_type));
  const accepted = envelopes.filter((e) => registered.has(e.event_type));

  const rows = await dataService.rows<ReplayLogRecord>(
    `INSERT INTO hdk_sync.replay_log (device_uuid, tenant_id, event_count)
     VALUES ($1, $2, $3)
     RETURNING batch_id, device_uuid, tenant_id, event_count, conflict_count, started_at, completed_at`,
    [device_uuid, tenant_id, accepted.length],
  );
  return { batch: rows[0], rejected };
}

export async function completeReplay(batch_id: string, conflict_count: number): Promise<ReplayLogRecord | null> {
  const rows = await dataService.rows<ReplayLogRecord>(
    `UPDATE hdk_sync.replay_log
        SET completed_at = now(), conflict_count = $2
      WHERE batch_id = $1
      RETURNING batch_id, device_uuid, tenant_id, event_count, conflict_count, started_at, completed_at`,
    [batch_id, conflict_count],
  );
  return rows[0] ?? null;
}

/**
 * Resolve a conflict between two payloads of the same event_type. Looks up
 * the registered policy and dispatches to the matching strategy. Records the
 * decision in hdk_sync.conflict (FR-HS-5) and, for human-review, opens a
 * task in hdk_sync.human_review_task.
 */
export async function resolveConflict(
  input: ResolveConflictInput,
  audit_entry_id?: string,
): Promise<ResolveConflictResult> {
  const policy = await getEventTypePolicy(input.event_type);
  if (!policy) {
    throw new Error(`event_type ${input.event_type} has no registered conflict_policy`);
  }
  const decision = resolveByPolicy(
    policy.conflict_policy,
    input.input_a,
    input.input_b,
    policy.strategy_detail,
  );

  // FR-HS-5: every conflict resolution writes an audit entry so the
  // tamper-evident chain holds even when CRDT/LWW pick deterministically.
  // Audit failure must not block sync replay — fall back to the caller-
  // supplied id if present, otherwise null.
  let resolved_audit_entry_id: string | null = audit_entry_id ?? null;
  if (!resolved_audit_entry_id) {
    try {
      const entry = await appendAuditEntry({
        pool_index: HDK_SYNC_AUDIT_POOL,
        event_type: decision.escalated_to_human
          ? 'hdk-sync.conflict.escalated-to-human.v1'
          : 'hdk-sync.conflict.resolved.v1',
        actor_kind: 'service',
        actor_id: 'hdk-sync.resolveConflict',
        subject_kind: 'hdk_sync.conflict',
        subject_id: input.event_type,
        retention_class: decision.escalated_to_human ? 'regulated' : 'operational',
        payload: {
          conflict_policy: policy.conflict_policy,
          strategy_detail: policy.strategy_detail,
          escalated_to_human: decision.escalated_to_human,
          input_a_keys: Object.keys(input.input_a),
          input_b_keys: Object.keys(input.input_b),
        },
      });
      resolved_audit_entry_id = entry.entry_id;
    } catch (err) {
       
      console.error('[hdk-sync] audit emit failed', (err as Error).message);
    }
  }

  const conflictRows = await dataService.rows<ConflictRecord>(
    `INSERT INTO hdk_sync.conflict
       (batch_id, event_type, conflict_policy, strategy_detail,
        input_a, input_b, resolved, escalated_to_human, audit_entry_id, resolved_at)
     VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7::jsonb, $8, $9, $10)
     RETURNING conflict_id, batch_id, event_type, conflict_policy, strategy_detail,
               input_a, input_b, resolved, escalated_to_human, audit_entry_id, resolved_at`,
    [
      input.batch_id ?? null,
      input.event_type,
      policy.conflict_policy,
      policy.strategy_detail,
      JSON.stringify(input.input_a),
      JSON.stringify(input.input_b),
      decision.resolved ? JSON.stringify(decision.resolved) : null,
      decision.escalated_to_human,
      resolved_audit_entry_id,
      decision.escalated_to_human ? null : new Date(),
    ],
  );
  const conflict = conflictRows[0];

  if (decision.escalated_to_human) {
    const taskRows = await dataService.rows<HumanReviewTaskRecord>(
      `INSERT INTO hdk_sync.human_review_task (conflict_id)
       VALUES ($1)
       RETURNING task_id, conflict_id, assignee_persona_id, status,
                 resolved_value, resolved_at, created_at`,
      [conflict.conflict_id],
    );
    return { conflict, human_review_task: taskRows[0] };
  }
  return { conflict };
}

export async function listOpenHumanReviewTasks(assignee_persona_id?: string): Promise<HumanReviewTaskRecord[]> {
  if (assignee_persona_id) {
    return dataService.rows<HumanReviewTaskRecord>(
      `SELECT task_id, conflict_id, assignee_persona_id, status,
              resolved_value, resolved_at, created_at
         FROM hdk_sync.human_review_task
        WHERE status IN ('open','in-review') AND assignee_persona_id = $1
        ORDER BY created_at`,
      [assignee_persona_id],
    );
  }
  return dataService.rows<HumanReviewTaskRecord>(
    `SELECT task_id, conflict_id, assignee_persona_id, status,
            resolved_value, resolved_at, created_at
       FROM hdk_sync.human_review_task
      WHERE status IN ('open','in-review')
      ORDER BY created_at`,
  );
}

export async function resolveHumanReview(
  task_id: string,
  status: ReviewStatus,
  resolved_value: Record<string, unknown> | null,
): Promise<HumanReviewTaskRecord | null> {
  const taskRows = await dataService.rows<HumanReviewTaskRecord>(
    `UPDATE hdk_sync.human_review_task
        SET status = $2,
            resolved_value = $3::jsonb,
            resolved_at    = CASE WHEN $2 IN ('resolved','rejected') THEN now() ELSE resolved_at END
      WHERE task_id = $1
      RETURNING task_id, conflict_id, assignee_persona_id, status,
                resolved_value, resolved_at, created_at`,
    [task_id, status, resolved_value ? JSON.stringify(resolved_value) : null],
  );
  const task = taskRows[0];
  if (task && status === 'resolved' && resolved_value) {
    await dataService.query(
      `UPDATE hdk_sync.conflict
          SET resolved = $2::jsonb,
              resolved_at = now()
        WHERE conflict_id = $1`,
      [task.conflict_id, JSON.stringify(resolved_value)],
    );
  }
  return task ?? null;
}
