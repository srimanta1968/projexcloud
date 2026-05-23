import crypto from 'crypto';
import { dataService } from '@projexlight/db-runtime';
import { appendAuditEntry } from '@projexlight/sdk-audit';
import type {
  EvaluationContext,
  EvaluationResult,
  FlagRecord,
  RolloutRecord,
  UpsertFlagInput,
  UpsertRolloutInput,
} from '../models/flag.model';

const FLAGS_AUDIT_POOL = process.env.FEATURE_FLAGS_AUDIT_POOL || 'admin-default';

async function emitFlagAudit(opts: {
  event_type:
    | 'feature-flag.updated.v1'
    | 'feature-flag.kill-switch.flipped.v1'
    | 'feature-flag.rollout.updated.v1';
  subject_id: string;
  actor_id: string;
  payload: Record<string, unknown>;
  retention_class?: 'operational' | 'regulated';
}): Promise<void> {
  try {
    await appendAuditEntry({
      pool_index: FLAGS_AUDIT_POOL,
      event_type: opts.event_type,
      actor_kind: 'service',
      actor_id: opts.actor_id,
      subject_kind: 'feature_flags.flag',
      subject_id: opts.subject_id,
      retention_class: opts.retention_class ?? 'operational',
      payload: opts.payload,
    });
  } catch (err) {
     
    console.error('[sdk-feature-flags] audit emit failed', opts.event_type, (err as Error).message);
  }
}

/**
 * Stable 0..99 hash bucket for a (flag, subject) pair. Determines whether a
 * subject is "in" a given % rollout. Uses SHA-256 truncated to 4 bytes for
 * uniform bucketing across orgs. Exported for unit testing.
 */
export function rolloutBucket(flag_id: string, subject: string): number {
  const h = crypto.createHash('sha256').update(`${flag_id}:${subject}`).digest();
  return h.readUInt32BE(0) % 100;
}

/**
 * sdk-feature-flags service per P3 PRD §5.7 / FR-FF-1..5.
 * Kill switches are load-bearing for P6A agent safety (FR-FF-2).
 */

export async function upsertFlag(input: UpsertFlagInput): Promise<FlagRecord> {
  const rows = await dataService.rows<FlagRecord>(
    `INSERT INTO feature_flags.flag
       (flag_id, description, kind, default_value, kill_switch, schema_ref)
     VALUES ($1, $2, $3, $4::jsonb, $5, $6)
     ON CONFLICT (flag_id) DO UPDATE SET
       description   = EXCLUDED.description,
       kind          = EXCLUDED.kind,
       default_value = EXCLUDED.default_value,
       kill_switch   = EXCLUDED.kill_switch,
       schema_ref    = EXCLUDED.schema_ref,
       updated_at    = now()
     RETURNING flag_id, description, kind, default_value, kill_switch, schema_ref,
               created_at, updated_at`,
    [
      input.flag_id,
      input.description ?? null,
      input.kind ?? 'boolean',
      JSON.stringify(input.default_value ?? false),
      input.kill_switch ?? false,
      input.schema_ref ?? null,
    ],
  );
  const flag = rows[0];
  await emitFlagAudit({
    event_type: 'feature-flag.updated.v1',
    subject_id: flag.flag_id,
    actor_id: 'sdk-feature-flags.upsertFlag',
    payload: { kind: flag.kind, kill_switch: flag.kill_switch, default_value: flag.default_value },
  });
  return flag;
}

export async function getFlag(flag_id: string): Promise<FlagRecord | null> {
  return dataService.one<FlagRecord>(
    `SELECT flag_id, description, kind, default_value, kill_switch, schema_ref,
            created_at, updated_at
       FROM feature_flags.flag WHERE flag_id = $1`,
    [flag_id],
  );
}

export async function listFlags(): Promise<FlagRecord[]> {
  return dataService.rows<FlagRecord>(
    `SELECT flag_id, description, kind, default_value, kill_switch, schema_ref,
            created_at, updated_at
       FROM feature_flags.flag ORDER BY flag_id`,
  );
}

export async function setKillSwitch(flag_id: string, engaged: boolean): Promise<FlagRecord | null> {
  const rows = await dataService.rows<FlagRecord>(
    `UPDATE feature_flags.flag
        SET kill_switch = $2, updated_at = now()
      WHERE flag_id = $1
      RETURNING flag_id, description, kind, default_value, kill_switch, schema_ref,
                created_at, updated_at`,
    [flag_id, engaged],
  );
  const flag = rows[0] ?? null;
  if (flag) {
    await emitFlagAudit({
      event_type: 'feature-flag.kill-switch.flipped.v1',
      subject_id: flag.flag_id,
      actor_id: 'sdk-feature-flags.setKillSwitch',
      payload: { engaged },
      retention_class: 'regulated',
    });
  }
  return flag;
}

export async function upsertRollout(input: UpsertRolloutInput): Promise<RolloutRecord> {
  const rows = await dataService.rows<RolloutRecord>(
    `INSERT INTO feature_flags.rollout
       (flag_id, tenant_id, predicate, value, priority, rollout_percent, active)
     VALUES ($1, $2, $3::jsonb, $4::jsonb, $5, $6, $7)
     RETURNING rollout_id, flag_id, tenant_id, predicate, value, priority,
               rollout_percent, active, created_at`,
    [
      input.flag_id,
      input.tenant_id ?? null,
      JSON.stringify(input.predicate ?? {}),
      JSON.stringify(input.value),
      input.priority ?? 100,
      input.rollout_percent ?? null,
      input.active ?? true,
    ],
  );
  const rollout = rows[0];
  await emitFlagAudit({
    event_type: 'feature-flag.rollout.updated.v1',
    subject_id: rollout.flag_id,
    actor_id: 'sdk-feature-flags.upsertRollout',
    payload: {
      rollout_id: rollout.rollout_id,
      tenant_id: rollout.tenant_id,
      priority: rollout.priority,
      rollout_percent: rollout.rollout_percent,
    },
  });
  return rollout;
}

/**
 * Evaluate a flag for a context. Order:
 *   1. If flag.kill_switch is TRUE → resolved_value = kind-appropriate "off" value.
 *   2. Otherwise pick the highest-priority active rollout whose predicate matches.
 *   3. Fallback to flag.default_value.
 *
 * Predicates are JSON objects whose keys must match keys in EvaluationContext.attributes
 * OR the structural fields (tenant_id, persona_id, bu_id). Equality match only — richer
 * predicate languages compose with sdk-policy IQL later.
 */
export async function evaluate(
  flag_id: string,
  context: EvaluationContext,
): Promise<EvaluationResult> {
  const flag = await getFlag(flag_id);
  if (!flag) {
    return { flag_id, resolved_value: null, matched_rollout_id: null, kill_switch_engaged: false };
  }

  if (flag.kill_switch) {
    const off = flag.kind === 'boolean' ? false : flag.kind === 'numeric' ? 0 : null;
    await sampleEvaluation(flag_id, context, off, null);
    return { flag_id, resolved_value: off, matched_rollout_id: null, kill_switch_engaged: true };
  }

  const rollouts = await dataService.rows<RolloutRecord>(
    `SELECT rollout_id, flag_id, tenant_id, predicate, value, priority,
            rollout_percent, active, created_at
       FROM feature_flags.rollout
      WHERE flag_id = $1 AND active = TRUE
        AND (tenant_id IS NULL OR tenant_id::text = $2::text)
      ORDER BY tenant_id NULLS LAST, priority ASC`,
    [flag_id, context.tenant_id ?? null],
  );

  // Subject to hash for % rollout — persona > tenant > anonymous bucket.
  const bucketSubject = context.persona_id ?? context.tenant_id ?? 'anon';

  for (const r of rollouts) {
    if (!predicateMatches(r.predicate, context)) continue;
    // FR-FF-3: % rollout gate. Deterministic per (flag, subject) so a given
    // subject either consistently sees the rollout or doesn't until the
    // operator widens the percentage.
    if (r.rollout_percent != null && rolloutBucket(flag_id, bucketSubject) >= r.rollout_percent) {
      continue;
    }
    await sampleEvaluation(flag_id, context, r.value, r.rollout_id);
    return { flag_id, resolved_value: r.value, matched_rollout_id: r.rollout_id, kill_switch_engaged: false };
  }

  await sampleEvaluation(flag_id, context, flag.default_value, null);
  return { flag_id, resolved_value: flag.default_value, matched_rollout_id: null, kill_switch_engaged: false };
}

/** Exported for unit testing — see tests/predicate.test.ts. */
export function predicateMatches(predicate: Record<string, unknown>, ctx: EvaluationContext): boolean {
  for (const [k, v] of Object.entries(predicate)) {
    const actual =
      k === 'tenant_id' ? ctx.tenant_id :
      k === 'persona_id' ? ctx.persona_id :
      k === 'bu_id' ? ctx.bu_id :
      ctx.attributes?.[k];
    if (Array.isArray(v)) {
      if (!v.includes(actual as never)) return false;
    } else if (actual !== v) {
      return false;
    }
  }
  return true;
}

async function sampleEvaluation(
  flag_id: string,
  ctx: EvaluationContext,
  value: unknown,
  matched_rollout_id: string | null,
): Promise<void> {
  // Sample 1% in production; here we record every evaluation for debug.
  try {
    await dataService.query(
      `INSERT INTO feature_flags.evaluation_sample
         (flag_id, tenant_id, persona_id, resolved_value, matched_rollout_id)
       VALUES ($1, $2, $3, $4::jsonb, $5)`,
      [flag_id, ctx.tenant_id ?? null, ctx.persona_id ?? null, JSON.stringify(value), matched_rollout_id],
    );
  } catch {
    // Best-effort telemetry — never fail evaluation on a sample insert error.
  }
}
