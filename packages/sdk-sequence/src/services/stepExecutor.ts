import { dataService } from '@projexlight/db-runtime';
import { checkFrequencyGuards, recordChannelOutcome } from './guardEngine';

/**
 * sdk-sequence step-executor tick loop (P14·E1). Port of the outreach
 * sequence-step-executor + send-queue + send-window.
 *
 * A durable tick that:
 *   1. Claims due execution_step rows (status pending/scheduled/deferred,
 *      next_run_at past) with FOR UPDATE SKIP LOCKED so multiple gateway pods
 *      never double-send the same touch.
 *   2. Gates each send against the sequence's send-window / quiet hours; a step
 *      outside the window is DEFERRED to the next open slot rather than sent.
 *   3. Emits the touch through the pluggable step sender (wired to
 *      sdk-notification by the app in Phase 2 — see setSequenceStepSender); a
 *      'wait' action just completes and advances.
 *   4. Idempotently enqueues the NEXT step (dedupe_key = enrollment:step_number
 *      + ON CONFLICT DO NOTHING against the partial-unique dedupe index), so a
 *      re-run of the same tick never schedules a duplicate touch.
 *
 * The sender is a hook (not a hard sdk-notification dependency) so the mechanism
 * stays reusable and unit-testable; the app injects the notification bridge that
 * resolves subject_persona_id -> person + template. Mirrors the resolver-hook
 * pattern used by sdk-assignment (setPersonaLocationResolver).
 */

const MAX_SEND_ATTEMPTS = 5;
const SEND_BACKOFF_SECONDS = [60, 300, 1800, 7200, 21600];

export interface ExecutableStep {
  execution_step_id: string;
  tenant_id: string;
  enrollment_id: string;
  sequence_id: string;
  step_id: string | null;
  step_number: number;
  subject_persona_id: string;
  channel: string | null;
  action: string | null;
  template_id: string | null;
}

export interface SendOutcome {
  delivered: boolean;
  provider_message_id?: string | null;
  error?: string;
}

export type SequenceStepSender = (step: ExecutableStep) => Promise<SendOutcome>;

/**
 * Default sender: records the emit intent without an external provider. The app
 * replaces this via setSequenceStepSender() with a bridge to sdk-notification
 * (resolving subject_persona_id -> person + template_code). Kept side-effect-free
 * so the executor is fully exercisable without notification infra configured.
 */
const defaultSender: SequenceStepSender = async () => ({ delivered: true, provider_message_id: null });

let _sender: SequenceStepSender = defaultSender;

/** Inject the send bridge (e.g. sdk-notification). */
export function setSequenceStepSender(sender: SequenceStepSender): void {
  _sender = sender;
}

/** Test hook — restore the default no-op sender. */
export function _resetSequenceStepSender(): void {
  _sender = defaultSender;
}

/**
 * Send-window / quiet-hours config (UTC-based). Read from sequence.metadata
 * .send_window; per-tenant local timezones are a future refinement.
 *   - days: allowed weekdays (0=Sun..6=Sat); undefined => all days.
 *   - quiet_start_hour / quiet_end_hour: closed window [start, end) in UTC hours.
 *     Supports overnight windows (start > end). Undefined => no quiet hours.
 */
export interface SendWindow {
  days?: number[];
  quiet_start_hour?: number;
  quiet_end_hour?: number;
}

function inQuietHours(hour: number, w: SendWindow): boolean {
  if (w.quiet_start_hour == null || w.quiet_end_hour == null) return false;
  const s = w.quiet_start_hour;
  const e = w.quiet_end_hour;
  if (s === e) return false;
  return s < e ? hour >= s && hour < e : hour >= s || hour < e;
}

function isSendable(at: Date, w: SendWindow): boolean {
  if (w.days && w.days.length > 0 && !w.days.includes(at.getUTCDay())) return false;
  if (inQuietHours(at.getUTCHours(), w)) return false;
  return true;
}

/**
 * Next time (from `from`) the window is open, or null when `from` is already
 * sendable. Forward hour-scan capped at 8 days (192h) — an all-day-quiet or
 * empty-days config never opens, so we stop and return the cap boundary.
 */
export function nextSendableTime(from: Date, w: SendWindow): Date | null {
  if (isSendable(from, w)) return null;
  // Advance to the next hour boundary, then scan.
  const cursor = new Date(from);
  cursor.setUTCMinutes(0, 0, 0);
  for (let i = 1; i <= 192; i++) {
    cursor.setUTCHours(cursor.getUTCHours() + 1);
    if (isSendable(cursor, w)) return new Date(cursor);
  }
  return new Date(cursor);
}

function resolveWindow(metadata: Record<string, unknown> | null | undefined): SendWindow {
  const raw = (metadata && (metadata.send_window as SendWindow | undefined)) || {};
  return {
    days: Array.isArray(raw.days) ? raw.days : undefined,
    quiet_start_hour: typeof raw.quiet_start_hour === 'number' ? raw.quiet_start_hour : undefined,
    quiet_end_hour: typeof raw.quiet_end_hour === 'number' ? raw.quiet_end_hour : undefined,
  };
}

export interface TickResult {
  claimed: number;
  sent: number;
  deferred: number;
  waited: number;
  failed: number;
  skipped: number;
  enqueued: number;
}

export interface ExecutorOptions {
  enabled: boolean;
  intervalMs: number;
  batchSize: number;
}

/** Start the durable executor on a timer. No-op when disabled. */
export function startSequenceExecutor(opts: ExecutorOptions): { stop: () => void } {
  if (!opts.enabled) return { stop: () => undefined };
  const timer = setInterval(() => {
    runSequenceTick(opts.batchSize).catch((err) => {
      console.error('[sdk-sequence] executor tick failed:', (err as Error).message);
    });
  }, opts.intervalMs);
  if (typeof timer.unref === 'function') timer.unref();
  return { stop: () => clearInterval(timer) };
}

/**
 * Run one executor tick. Claims up to `batchSize` due steps and advances each:
 * send-window-defer, wait-complete, or send + idempotent next-step enqueue.
 */
export async function runSequenceTick(batchSize = 50): Promise<TickResult> {
  const now = new Date();
  const claimed = await dataService.rows<ExecutableStep>(
    `UPDATE sequence.execution_step
        SET status = 'sending', updated_at = now()
      WHERE execution_step_id IN (
        SELECT execution_step_id FROM sequence.execution_step
         WHERE status IN ('pending','scheduled','deferred')
           AND next_run_at IS NOT NULL
           AND next_run_at <= now()
         ORDER BY next_run_at ASC
         LIMIT $1
         FOR UPDATE SKIP LOCKED
      )
      RETURNING execution_step_id, tenant_id, enrollment_id, sequence_id, step_id,
                step_number, subject_persona_id, channel, action, template_id`,
    [batchSize],
  );

  const result: TickResult = { claimed: claimed.length, sent: 0, deferred: 0, waited: 0, failed: 0, skipped: 0, enqueued: 0 };

  for (const step of claimed) {
    // 'wait' actions have no send — complete and advance immediately.
    if (step.action === 'wait') {
      await markStatus(step.execution_step_id, 'sent', { waited: true });
      result.waited++;
      if (await enqueueNextStep(step)) result.enqueued++;
      continue;
    }

    // Send-window gating.
    const seq = await dataService.one<{ metadata: Record<string, unknown> }>(
      `SELECT metadata FROM sequence.sequence WHERE sequence_id = $1`,
      [step.sequence_id],
    );
    const window = resolveWindow(seq?.metadata);
    const deferUntil = nextSendableTime(now, window);
    if (deferUntil) {
      await dataService.query(
        `UPDATE sequence.execution_step
            SET status = 'deferred', next_run_at = $2, updated_at = now()
          WHERE execution_step_id = $1`,
        [step.execution_step_id, deferUntil.toISOString()],
      );
      result.deferred++;
      continue;
    }

    // Frequency-cap + circuit-breaker guards (logged to guard_log). A blocked
    // touch is skipped and the cadence advances to the next step.
    const channel = step.channel ?? 'email';
    const guard = await checkFrequencyGuards({
      tenant_id: step.tenant_id,
      subject_persona_id: step.subject_persona_id,
      channel,
      execution_step_id: step.execution_step_id,
    });
    if (!guard.allowed) {
      await markSkipped(step.execution_step_id, guard.reason ?? 'guard');
      result.skipped++;
      if (await enqueueNextStep(step)) result.enqueued++;
      continue;
    }

    // Emit via the pluggable sender.
    let outcome: SendOutcome;
    try {
      outcome = await _sender(step);
    } catch (err) {
      outcome = { delivered: false, error: (err as Error).message };
    }

    // Feed the circuit breaker (best-effort — never fail the tick on breaker I/O).
    try {
      await recordChannelOutcome(step.tenant_id, channel, outcome.delivered);
    } catch (err) {
      console.warn('[sdk-sequence] breaker outcome record failed:', (err as Error).message);
    }

    if (outcome.delivered) {
      await markStatus(step.execution_step_id, 'sent', {
        provider_message_id: outcome.provider_message_id ?? null,
      });
      result.sent++;
      if (await enqueueNextStep(step)) result.enqueued++;
    } else {
      await failStep(step.execution_step_id, outcome.error ?? 'send failed');
      result.failed++;
    }
  }

  return result;
}

async function markStatus(execution_step_id: string, status: 'sent', result: Record<string, unknown>): Promise<void> {
  await dataService.query(
    `UPDATE sequence.execution_step
        SET status = $2, executed_at = now(), attempt_count = attempt_count + 1,
            result = $3::jsonb, updated_at = now()
      WHERE execution_step_id = $1`,
    [execution_step_id, status, JSON.stringify(result)],
  );
}

async function markSkipped(execution_step_id: string, reason: string): Promise<void> {
  await dataService.query(
    `UPDATE sequence.execution_step
        SET status = 'skipped', control_reason = $2, updated_at = now()
      WHERE execution_step_id = $1`,
    [execution_step_id, reason],
  );
}

async function failStep(execution_step_id: string, error: string): Promise<void> {
  // Re-queue with backoff until attempts are exhausted, then mark 'failed'.
  await dataService.query(
    `UPDATE sequence.execution_step
        SET attempt_count = attempt_count + 1,
            last_error = $2,
            status = CASE WHEN attempt_count + 1 >= $3 THEN 'failed' ELSE 'pending' END,
            next_run_at = CASE WHEN attempt_count + 1 >= $3 THEN next_run_at
                               ELSE now() + ($4 || ' seconds')::interval END,
            updated_at = now()
      WHERE execution_step_id = $1`,
    [
      execution_step_id,
      error.slice(0, 2000),
      MAX_SEND_ATTEMPTS,
      String(SEND_BACKOFF_SECONDS[Math.min(MAX_SEND_ATTEMPTS - 1, SEND_BACKOFF_SECONDS.length - 1)]),
    ],
  );
}

/**
 * Idempotently enqueue the next step in the sequence for this enrollment.
 * dedupe_key = `${enrollment_id}:${next_step_number}` collides with the partial
 * unique index (dedupe_key WHERE NOT NULL), so ON CONFLICT DO NOTHING makes a
 * repeated tick a no-op. Returns true when a new row was inserted.
 */
async function enqueueNextStep(step: ExecutableStep): Promise<boolean> {
  const next = await dataService.one<{
    step_id: string; step_number: number; channel: string; action: string; delay_seconds: number; template_id: string | null;
  }>(
    `SELECT step_id, step_number, channel, action, delay_seconds, template_id
       FROM sequence.step
      WHERE tenant_id = $1 AND sequence_id = $2 AND step_number > $3
      ORDER BY step_number ASC
      LIMIT 1`,
    [step.tenant_id, step.sequence_id, step.step_number],
  );
  if (!next) return false; // sequence complete for this enrollment.

  const dedupe_key = `${step.enrollment_id}:${next.step_number}`;
  const inserted = await dataService.rows<{ execution_step_id: string }>(
    `INSERT INTO sequence.execution_step
       (tenant_id, enrollment_id, sequence_id, step_id, step_number, subject_persona_id,
        channel, action, template_id, status, next_run_at, scheduled_at, dedupe_key)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'pending',
             now() + ($10 || ' seconds')::interval, now() + ($10 || ' seconds')::interval, $11)
     ON CONFLICT (dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING
     RETURNING execution_step_id`,
    [
      step.tenant_id, step.enrollment_id, step.sequence_id, next.step_id, next.step_number,
      step.subject_persona_id, next.channel, next.action, next.template_id, String(next.delay_seconds), dedupe_key,
    ],
  );
  return inserted.length > 0;
}
