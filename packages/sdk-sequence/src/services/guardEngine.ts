import { dataService } from '@projexlight/db-runtime';

/**
 * sdk-sequence frequency-cap + circuit-breaker guard engine (P14·E1). Ports the
 * outreach-orchestrator guard engine:
 *   - per-lead cooldown: minimum gap between touches to the same subject;
 *   - max-messages: cap per subject over a rolling window;
 *   - dedup: block re-sending identical content within the window;
 *   - circuit breaker: per-(tenant,channel) open on repeated send failures,
 *     half-open after a cooldown to probe, close on the first success.
 * Every decision is written to the append-only guard_log audit trail.
 */

export interface GuardConfig {
  enabled: boolean;
  cooldown_seconds: number;
  max_messages: number;
  window_seconds: number;
  breaker_failure_threshold: number;
  breaker_cooldown_seconds: number;
}

const DEFAULT_CONFIG: GuardConfig = {
  enabled: true,
  cooldown_seconds: 3600,
  max_messages: 5,
  window_seconds: 86400,
  breaker_failure_threshold: 5,
  breaker_cooldown_seconds: 300,
};

export type GuardReason = 'cooldown' | 'max_messages' | 'duplicate' | 'circuit_open';

export interface GuardDecision {
  allowed: boolean;
  reason: GuardReason | null;
}

export interface GuardCheckInput {
  tenant_id: string;
  subject_persona_id: string;
  channel: string;
  dedupe_hash?: string;
  execution_step_id?: string;
}

/** Load a tenant's guard config, falling back to the defaults when unset. */
export async function loadGuardConfig(tenant_id: string): Promise<GuardConfig> {
  const row = await dataService.one<GuardConfig>(
    `SELECT enabled, cooldown_seconds, max_messages, window_seconds,
            breaker_failure_threshold, breaker_cooldown_seconds
       FROM sequence.guard_config WHERE tenant_id = $1`,
    [tenant_id],
  );
  return row ?? DEFAULT_CONFIG;
}

/** Upsert a tenant's guard config (partial — unset fields keep their value). */
export async function upsertGuardConfig(
  tenant_id: string,
  patch: Partial<GuardConfig>,
): Promise<GuardConfig> {
  const row = await dataService.one<GuardConfig>(
    `INSERT INTO sequence.guard_config
       (tenant_id, enabled, cooldown_seconds, max_messages, window_seconds,
        breaker_failure_threshold, breaker_cooldown_seconds)
     VALUES ($1,
             COALESCE($2, true), COALESCE($3, 3600), COALESCE($4, 5),
             COALESCE($5, 86400), COALESCE($6, 5), COALESCE($7, 300))
     ON CONFLICT (tenant_id) DO UPDATE SET
       enabled                   = COALESCE($2, sequence.guard_config.enabled),
       cooldown_seconds          = COALESCE($3, sequence.guard_config.cooldown_seconds),
       max_messages              = COALESCE($4, sequence.guard_config.max_messages),
       window_seconds            = COALESCE($5, sequence.guard_config.window_seconds),
       breaker_failure_threshold = COALESCE($6, sequence.guard_config.breaker_failure_threshold),
       breaker_cooldown_seconds  = COALESCE($7, sequence.guard_config.breaker_cooldown_seconds),
       updated_at = now()
     RETURNING enabled, cooldown_seconds, max_messages, window_seconds,
               breaker_failure_threshold, breaker_cooldown_seconds`,
    [
      tenant_id,
      patch.enabled ?? null,
      patch.cooldown_seconds ?? null,
      patch.max_messages ?? null,
      patch.window_seconds ?? null,
      patch.breaker_failure_threshold ?? null,
      patch.breaker_cooldown_seconds ?? null,
    ],
  );
  return row ?? DEFAULT_CONFIG;
}

async function logGuard(
  input: GuardCheckInput,
  decision: 'allow' | 'block',
  reason: GuardReason | null,
): Promise<void> {
  await dataService.query(
    `INSERT INTO sequence.guard_log
       (tenant_id, subject_persona_id, channel, decision, reason, execution_step_id, dedupe_hash)
     VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [
      input.tenant_id, input.subject_persona_id, input.channel, decision, reason,
      input.execution_step_id ?? null, input.dedupe_hash ?? null,
    ],
  );
}

/**
 * Evaluate the frequency + breaker guards for a prospective send and record the
 * decision to guard_log. Returns { allowed, reason }. When guards are disabled
 * for the tenant, always allows (still logged).
 */
export async function checkFrequencyGuards(input: GuardCheckInput): Promise<GuardDecision> {
  const cfg = await loadGuardConfig(input.tenant_id);
  if (!cfg.enabled) {
    await logGuard(input, 'allow', null);
    return { allowed: true, reason: null };
  }

  // 1. Circuit breaker (per tenant+channel). Open + still cooling -> block.
  const breaker = await dataService.one<{ state: string; opened_at: string | null }>(
    `SELECT state, opened_at FROM sequence.circuit_breaker WHERE tenant_id = $1 AND channel = $2`,
    [input.tenant_id, input.channel],
  );
  if (breaker && breaker.state === 'open') {
    const coolUntil = breaker.opened_at
      ? new Date(new Date(breaker.opened_at).getTime() + cfg.breaker_cooldown_seconds * 1000)
      : null;
    if (coolUntil && coolUntil.getTime() > Date.now()) {
      await logGuard(input, 'block', 'circuit_open');
      return { allowed: false, reason: 'circuit_open' };
    }
    // Cooldown elapsed — half-open to allow a single probe send.
    await dataService.query(
      `UPDATE sequence.circuit_breaker SET state = 'half_open', updated_at = now()
        WHERE tenant_id = $1 AND channel = $2`,
      [input.tenant_id, input.channel],
    );
  }

  // 2. Per-lead cooldown: last sent touch to this subject.
  const lastSent = await dataService.one<{ last: string | null }>(
    `SELECT MAX(executed_at) AS last
       FROM sequence.execution_step
      WHERE tenant_id = $1 AND subject_persona_id = $2 AND status = 'sent'`,
    [input.tenant_id, input.subject_persona_id],
  );
  if (lastSent?.last) {
    const gapMs = Date.now() - new Date(lastSent.last).getTime();
    if (gapMs < cfg.cooldown_seconds * 1000) {
      await logGuard(input, 'block', 'cooldown');
      return { allowed: false, reason: 'cooldown' };
    }
  }

  // 3. Max messages per rolling window.
  const windowCount = await dataService.one<{ c: string }>(
    `SELECT count(*)::text AS c
       FROM sequence.execution_step
      WHERE tenant_id = $1 AND subject_persona_id = $2 AND status = 'sent'
        AND executed_at > now() - ($3 || ' seconds')::interval`,
    [input.tenant_id, input.subject_persona_id, String(cfg.window_seconds)],
  );
  if (parseInt(windowCount?.c ?? '0', 10) >= cfg.max_messages) {
    await logGuard(input, 'block', 'max_messages');
    return { allowed: false, reason: 'max_messages' };
  }

  // 4. Content dedup: identical content already allowed within the window.
  if (input.dedupe_hash) {
    const dup = await dataService.one<{ guard_id: string }>(
      `SELECT guard_id FROM sequence.guard_log
        WHERE tenant_id = $1 AND dedupe_hash = $2 AND decision = 'allow'
          AND created_at > now() - ($3 || ' seconds')::interval
        LIMIT 1`,
      [input.tenant_id, input.dedupe_hash, String(cfg.window_seconds)],
    );
    if (dup) {
      await logGuard(input, 'block', 'duplicate');
      return { allowed: false, reason: 'duplicate' };
    }
  }

  await logGuard(input, 'allow', null);
  return { allowed: true, reason: null };
}

export interface BreakerState {
  state: 'closed' | 'open' | 'half_open';
  failure_count: number;
  success_count: number;
}

/**
 * Record a send outcome for the (tenant, channel) breaker. A success resets the
 * failure streak (and closes a half-open breaker); a failure increments it and
 * opens the breaker once the threshold is reached.
 */
export async function recordChannelOutcome(
  tenant_id: string,
  channel: string,
  success: boolean,
): Promise<BreakerState> {
  const cfg = await loadGuardConfig(tenant_id);
  const row = await dataService.one<BreakerState>(
    `INSERT INTO sequence.circuit_breaker (tenant_id, channel, state, failure_count, success_count, opened_at)
     VALUES ($1, $2, CASE WHEN $3 THEN 'closed' ELSE 'closed' END, CASE WHEN $3 THEN 0 ELSE 1 END, CASE WHEN $3 THEN 1 ELSE 0 END, NULL)
     ON CONFLICT (tenant_id, channel) DO UPDATE SET
       failure_count = CASE WHEN $3 THEN 0 ELSE sequence.circuit_breaker.failure_count + 1 END,
       success_count = CASE WHEN $3 THEN sequence.circuit_breaker.success_count + 1 ELSE sequence.circuit_breaker.success_count END,
       state = CASE
                 WHEN $3 THEN 'closed'
                 WHEN sequence.circuit_breaker.failure_count + 1 >= $4 THEN 'open'
                 ELSE sequence.circuit_breaker.state
               END,
       opened_at = CASE
                     WHEN NOT $3 AND sequence.circuit_breaker.failure_count + 1 >= $4
                       THEN now()
                     WHEN $3 THEN NULL
                     ELSE sequence.circuit_breaker.opened_at
                   END,
       updated_at = now()
     RETURNING state, failure_count, success_count`,
    [tenant_id, channel, success, cfg.breaker_failure_threshold],
  );
  return row ?? { state: 'closed', failure_count: 0, success_count: 0 };
}

export interface GuardLogEntry {
  guard_id: string;
  tenant_id: string;
  subject_persona_id: string | null;
  channel: string | null;
  decision: 'allow' | 'block';
  reason: string | null;
  execution_step_id: string | null;
  dedupe_hash: string | null;
  created_at: string;
}

/** List recent guard decisions for a tenant (audit log), newest first. */
export async function listGuardLog(
  tenant_id: string,
  opts: { decision?: 'allow' | 'block'; limit?: number } = {},
): Promise<GuardLogEntry[]> {
  return dataService.rows<GuardLogEntry>(
    `SELECT guard_id, tenant_id, subject_persona_id, channel, decision, reason,
            execution_step_id, dedupe_hash, created_at
       FROM sequence.guard_log
      WHERE tenant_id = $1
        AND ($2::text IS NULL OR decision = $2)
      ORDER BY created_at DESC
      LIMIT $3`,
    [tenant_id, opts.decision ?? null, opts.limit ?? 100],
  );
}
