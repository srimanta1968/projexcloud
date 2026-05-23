import { dataService } from '@projexlight/db-runtime';

/**
 * SLA timer scheduler per FR-APP-5.
 *
 * Periodically scans approval.step rows whose sla_deadline has passed and
 * whose decision is still null. For each, sets auto_escalated=true and
 * advances the parent request to status='escalated' (or 'timed-out' if
 * configured to fail-on-timeout).
 *
 * Leader election (multi-pod safety): each tick wraps its work in a Postgres
 * advisory transaction lock keyed by (ADVISORY_NS, LOCK_ID_SLA_TIMER).
 * Without this, every replica fired the same UPDATE concurrently. The
 * `auto_escalated = FALSE` filter limited the data damage, but the racing
 * audit emits (downstream) were duplicated N times per tick.
 *
 * Production wires a notification call here (sdk-notification) and may
 * also trigger sdk-approval delegation to a fallback persona; v1 keeps
 * the escalation purely as a state flip + audit event.
 */

// 0x41505052 = "APPR". Per-scheduler lock_id distinguishes slaTimer from
// future delegation/notify tickers in the same SDK.
const ADVISORY_NS = 0x41505052;
const LOCK_ID_SLA_TIMER = 1;

async function withLeaderLock(lock_id: number, body: () => Promise<void>): Promise<boolean> {
  let acquired = false;
  try {
    await dataService.query('BEGIN');
    const row = await dataService.one<{ locked: boolean }>(
      `SELECT pg_try_advisory_xact_lock($1, $2) AS locked`,
      [ADVISORY_NS, lock_id],
    );
    acquired = row?.locked === true;
    if (!acquired) {
      await dataService.query('COMMIT');
      return false;
    }
    await body();
    await dataService.query('COMMIT');
    return true;
  } catch (err) {
    try { await dataService.query('ROLLBACK'); } catch { /* ignore */ }
    throw err;
  }
}

export interface SlaTimerOptions {
  enabled: boolean;
  intervalMs: number;
  /** When true, an escalated step transitions the request to 'timed-out'
   *  (final state) instead of 'escalated' (intermediate). */
  failOnTimeout: boolean;
}

export interface SlaTimerHandle {
  stop: () => void;
}

export function startSlaTimer(opts: SlaTimerOptions): SlaTimerHandle {
  if (!opts.enabled) return { stop: () => undefined };
  const timer = setInterval(() => {
    withLeaderLock(LOCK_ID_SLA_TIMER, async () => {
      await runSlaTick(opts.failOnTimeout);
    }).catch((err) => {
      console.error('[sdk-approval] SLA tick failed:', err);
    });
  }, opts.intervalMs);
  return { stop: () => clearInterval(timer) };
}

export interface SlaTickResult {
  escalated_steps: number;
  affected_requests: number;
}

export async function runSlaTick(failOnTimeout = false): Promise<SlaTickResult> {
  // Mark expired pending steps as auto_escalated.
  const updated = await dataService.rows<{ step_id: string; request_id: string }>(
    `UPDATE approval.step
        SET auto_escalated = TRUE
      WHERE decision IS NULL
        AND acted_at IS NULL
        AND auto_escalated = FALSE
        AND sla_deadline IS NOT NULL
        AND sla_deadline < now()
    RETURNING step_id, request_id`,
  );

  if (updated.length === 0) return { escalated_steps: 0, affected_requests: 0 };

  const requestIds = Array.from(new Set(updated.map((r) => r.request_id)));
  const newStatus = failOnTimeout ? 'timed-out' : 'escalated';

  // Only flip pending requests; don't disturb requests already resolved.
  await dataService.query(
    `UPDATE approval.request
        SET status = $2,
            resolved_at = CASE WHEN $2 = 'timed-out' THEN now() ELSE resolved_at END
      WHERE request_id = ANY($1::uuid[]) AND status = 'pending'`,
    [requestIds, newStatus],
  );

  return {
    escalated_steps: updated.length,
    affected_requests: requestIds.length,
  };
}
