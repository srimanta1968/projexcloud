import { createHash } from 'crypto';
import { dataService } from '@projexlight/db-runtime';
import { emitEvent } from '@projexlight/sdk-audit';
import {
  explainProjection,
  type ExplainedProjection,
} from './explainedProjectionService';

/**
 * Deterministic replay (P16 · EP-382).
 *
 * Rebuilds a subject's projection FROM THE ASSERTION LOG rather than patching it.
 *
 * Patching is the tempting shortcut and it fails in a way that only surfaces later: to
 * patch you must know what the retracted assertion contributed, which means trusting a
 * delta computed against a state you no longer hold. Two patches applied in a different
 * order then disagree and nothing can say which is right. A replay reads the surviving
 * assertions and derives the answer, so the result depends only on the log's CONTENT —
 * never on the path taken to reach it. That is what makes it both deterministic and
 * idempotent, and the two properties are really the same property.
 *
 * The content hash makes determinism machine-checkable rather than asserted: it is taken
 * over a CANONICAL form of the projection, excluding the wall-clock stamp that would
 * otherwise differ on every run and make every replay look like a change.
 */

const PROJECTION_AUDIT_POOL = process.env.PROJECTION_AUDIT_POOL || 'admin-default';

export type ReplayTrigger = 'manual' | 'retraction' | 'supersede' | 'rule_change' | 'backfill';

export interface ReplayResult {
  tenant_id: string;
  subject_ref: string;
  content_hash: string;
  /** False when the rebuilt projection is identical to the stored one. */
  changed: boolean;
  previous_hash: string | null;
  assertion_count: number;
  attribute_count: number;
  duration_ms: number;
  trigger: ReplayTrigger;
  projection: ExplainedProjection;
}

/**
 * Canonical form for hashing.
 *
 * Everything time-varying is stripped and every collection is emitted in a fixed order, so
 * the hash reflects the DECISION and not the moment it was taken. Hashing the raw response
 * would embed projected_at and make two identical replays look different — the exact
 * failure this hash exists to detect.
 */
export function canonicalizeProjection(p: ExplainedProjection): string {
  return JSON.stringify({
    tenant_id: p.tenant_id,
    subject_ref: p.subject_ref,
    excluded_count: p.excluded_count,
    attributes: p.attributes.map((a) => ({
      attribute: a.attribute,
      surviving_value: a.surviving_value,
      surviving_assertion_id: a.surviving_assertion?.assertion_id ?? null,
      rules_source: a.rules.source,
      rules_criteria: a.rules.criteria,
      // Losers are already in a deterministic order from the projection; the reason string
      // is included because a CHANGED explanation is a changed projection even when the
      // winner is the same — a user reading "why" would see something different.
      losing: a.losing.map((l) => ({
        assertion_id: l.assertion.assertion_id,
        reason: l.reason,
        decided_by: l.decided_by,
      })),
    })),
  });
}

export function hashProjection(p: ExplainedProjection): string {
  return createHash('sha256').update(canonicalizeProjection(p)).digest('hex');
}

export interface ReplaySubjectInput {
  tenant_id: string;
  subject_ref: string;
  trigger?: ReplayTrigger;
  reason?: string;
  /** Skip the audit emit — used by bulk backfills that emit one summary instead. */
  suppress_audit?: boolean;
}

/**
 * Rebuild one subject and persist the snapshot.
 *
 * Idempotent by construction: the same log yields the same hash, and the snapshot is an
 * upsert keyed on (tenant_id, subject_ref), so replaying twice leaves one row with
 * replay_count incremented rather than a second row or a mutated projection.
 */
export async function replaySubject(input: ReplaySubjectInput): Promise<ReplayResult> {
  if (!input.tenant_id) throw new Error('[sdk-projection] replaySubject requires tenant_id');
  if (!input.subject_ref?.trim()) {
    throw new Error('[sdk-projection] replaySubject requires subject_ref');
  }
  const trigger: ReplayTrigger = input.trigger ?? 'manual';
  const startedAt = Date.now();

  const projection = await explainProjection({
    tenant_id: input.tenant_id,
    subject_ref: input.subject_ref,
  });
  const content_hash = hashProjection(projection);
  const assertion_count =
    projection.attributes.reduce((n, a) => n + 1 + a.losing.length, 0) + projection.excluded_count;
  const attribute_count = projection.attributes.length;

  const prior = await dataService.one<{ content_hash: string }>(
    `SELECT content_hash FROM projection.replay_snapshot
      WHERE tenant_id = $1::uuid AND subject_ref = $2`,
    [input.tenant_id, input.subject_ref],
  );
  const previous_hash = prior?.content_hash ?? null;
  const changed = previous_hash !== content_hash;
  const duration_ms = Date.now() - startedAt;

  await dataService.query(
    `INSERT INTO projection.replay_snapshot
       (tenant_id, subject_ref, content_hash, projection, assertion_count,
        attribute_count, replay_count, last_reason, last_trigger, duration_ms, replayed_at)
     VALUES ($1::uuid, $2, $3, $4::jsonb, $5, $6, 1, $7, $8, $9, now())
     ON CONFLICT (tenant_id, subject_ref) DO UPDATE
       SET content_hash = EXCLUDED.content_hash,
           projection = EXCLUDED.projection,
           assertion_count = EXCLUDED.assertion_count,
           attribute_count = EXCLUDED.attribute_count,
           replay_count = projection.replay_snapshot.replay_count + 1,
           last_reason = EXCLUDED.last_reason,
           last_trigger = EXCLUDED.last_trigger,
           duration_ms = EXCLUDED.duration_ms,
           replayed_at = now()`,
    [
      input.tenant_id,
      input.subject_ref,
      content_hash,
      JSON.stringify(projection),
      assertion_count,
      attribute_count,
      input.reason ?? null,
      trigger,
      duration_ms,
    ],
  );

  if (!input.suppress_audit) {
    // Evidence, not telemetry: this record is what shows a retraction actually propagated
    // to the projection, which is precisely what an auditor asks for. Emitted even when
    // nothing changed — "we replayed and it made no difference" is itself the answer.
    await emitEvent({
      event_type: 'projection.replay.completed.v1',
      pool_index: PROJECTION_AUDIT_POOL,
      actor_id: 'sdk-projection',
      actor_kind: 'service',
      tenant_id: input.tenant_id,
      subject_kind: 'projection.subject',
      subject_id: input.subject_ref,
      payload: {
        subject_ref: input.subject_ref,
        trigger,
        reason: input.reason ?? null,
        content_hash,
        previous_hash,
        changed,
        assertion_count,
        attribute_count,
        duration_ms,
      },
    });
  }

  return {
    tenant_id: input.tenant_id,
    subject_ref: input.subject_ref,
    content_hash,
    changed,
    previous_hash,
    assertion_count,
    attribute_count,
    duration_ms,
    trigger,
    projection,
  };
}

/**
 * Retract an assertion and replay every subject it touched (AC2).
 *
 * The replay is part of THIS call rather than a queued follow-up. A retraction whose
 * propagation is merely scheduled leaves a window in which the projection still shows a
 * value the tenant has formally withdrawn — and that window is exactly when someone reads
 * it. Coupling them means a successful retraction has, by definition, already propagated.
 */
export async function retractAndReplay(input: {
  tenant_id: string;
  assertion_id: string;
  reason?: string;
}): Promise<{ retracted: boolean; replays: ReplayResult[] }> {
  const row = await dataService.one<{ subject_ref: string }>(
    `UPDATE projection.attribute_assertion
        SET retracted_at = COALESCE(retracted_at, now())
      WHERE tenant_id = $1::uuid AND assertion_id = $2::uuid
    RETURNING subject_ref`,
    [input.tenant_id, input.assertion_id],
  );
  if (!row) return { retracted: false, replays: [] };

  await emitEvent({
    event_type: 'projection.assertion.retracted.v1',
    pool_index: PROJECTION_AUDIT_POOL,
    actor_id: 'sdk-projection',
    actor_kind: 'service',
    tenant_id: input.tenant_id,
    subject_kind: 'projection.assertion',
    subject_id: input.assertion_id,
    payload: {
      assertion_id: input.assertion_id,
      subject_ref: row.subject_ref,
      reason: input.reason ?? null,
    },
  });

  const replay = await replaySubject({
    tenant_id: input.tenant_id,
    subject_ref: row.subject_ref,
    trigger: 'retraction',
    reason: input.reason ?? `assertion ${input.assertion_id} retracted`,
  });
  return { retracted: true, replays: [replay] };
}

/**
 * Supersede one assertion with another, then replay.
 *
 * The link is recorded rather than the old row being deleted, so the superseded assertion
 * still explains what the projection said before — the same reason retraction is a state.
 */
export async function supersedeAndReplay(input: {
  tenant_id: string;
  assertion_id: string;
  superseded_by: string;
  reason?: string;
}): Promise<{ superseded: boolean; replays: ReplayResult[] }> {
  if (input.assertion_id === input.superseded_by) {
    throw new Error('[sdk-projection] an assertion cannot supersede itself');
  }
  const row = await dataService.one<{ subject_ref: string }>(
    `UPDATE projection.attribute_assertion
        SET superseded_by = $3::uuid,
            retracted_at = COALESCE(retracted_at, now())
      WHERE tenant_id = $1::uuid AND assertion_id = $2::uuid
    RETURNING subject_ref`,
    [input.tenant_id, input.assertion_id, input.superseded_by],
  );
  if (!row) return { superseded: false, replays: [] };

  const replay = await replaySubject({
    tenant_id: input.tenant_id,
    subject_ref: row.subject_ref,
    trigger: 'supersede',
    reason: input.reason ?? `superseded by ${input.superseded_by}`,
  });
  return { superseded: true, replays: [replay] };
}

/**
 * Replay every subject affected by a rule change.
 *
 * Bounded and reported rather than unbounded: a tenant with a million subjects must not
 * have a rule edit turn into an unbounded synchronous sweep, so the caller gets
 * `remaining` and decides whether to continue. Silently truncating would read as "done".
 */
export async function replayTenant(input: {
  tenant_id: string;
  trigger?: ReplayTrigger;
  reason?: string;
  limit?: number;
}): Promise<{ replayed: number; changed: number; remaining: number; results: ReplayResult[] }> {
  const limit = Math.min(Math.max(input.limit ?? 100, 1), 1000);
  const subjects = await dataService.query<{ subject_ref: string }>(
    `SELECT DISTINCT subject_ref
       FROM projection.attribute_assertion
      WHERE tenant_id = $1::uuid
      ORDER BY subject_ref
      LIMIT $2`,
    [input.tenant_id, limit],
  );
  const total = await dataService.one<{ n: string }>(
    `SELECT count(DISTINCT subject_ref)::text AS n
       FROM projection.attribute_assertion WHERE tenant_id = $1::uuid`,
    [input.tenant_id],
  );

  const results: ReplayResult[] = [];
  for (const s of subjects.rows) {
    results.push(
      await replaySubject({
        tenant_id: input.tenant_id,
        subject_ref: s.subject_ref,
        trigger: input.trigger ?? 'rule_change',
        reason: input.reason,
        // One summary rather than N events: a rule change that touches 900 subjects should
        // not bury the ledger, and each subject's snapshot already records its own hash.
        suppress_audit: true,
      }),
    );
  }

  await emitEvent({
    event_type: 'projection.replay.completed.v1',
    pool_index: PROJECTION_AUDIT_POOL,
    actor_id: 'sdk-projection',
    actor_kind: 'service',
    tenant_id: input.tenant_id,
    subject_kind: 'projection.tenant',
    subject_id: input.tenant_id,
    payload: {
      scope: 'tenant',
      trigger: input.trigger ?? 'rule_change',
      reason: input.reason ?? null,
      replayed: results.length,
      changed: results.filter((r) => r.changed).length,
      remaining: Math.max(Number(total?.n ?? 0) - results.length, 0),
    },
  });

  return {
    replayed: results.length,
    changed: results.filter((r) => r.changed).length,
    remaining: Math.max(Number(total?.n ?? 0) - results.length, 0),
    results,
  };
}

export async function getReplaySnapshot(input: {
  tenant_id: string;
  subject_ref: string;
}): Promise<{
  content_hash: string;
  projection: ExplainedProjection;
  replay_count: number;
  replayed_at: string;
  last_trigger: string;
} | null> {
  const row = await dataService.one<{
    content_hash: string;
    projection: ExplainedProjection;
    replay_count: number;
    replayed_at: Date;
    last_trigger: string;
  }>(
    `SELECT content_hash, projection, replay_count, replayed_at, last_trigger
       FROM projection.replay_snapshot
      WHERE tenant_id = $1::uuid AND subject_ref = $2`,
    [input.tenant_id, input.subject_ref],
  );
  if (!row) return null;
  return {
    content_hash: row.content_hash,
    projection: row.projection,
    replay_count: Number(row.replay_count),
    replayed_at: row.replayed_at.toISOString(),
    last_trigger: row.last_trigger,
  };
}
