import { dataService } from '@projexlight/db-runtime';

/**
 * sdk-sequence reactive control (P14·E1). Ports the outreach sequence
 * cancellation + reply/booking reactive triggers:
 *   - pause  (pause-on-reply): queued steps -> 'paused' (executor skips them);
 *   - resume: 'paused' -> 'pending' so the cadence continues;
 *   - stop   (stop-on-optout / stop-on-payment): all still-queued steps
 *     'canceled' with reason captured (queued-step cancellation);
 *   - replace_cta: swap the template on upcoming steps in place.
 *
 * "Queued" = the pre-send states pending/scheduled/deferred/paused. Steps
 * already sent/failed/canceled are terminal and untouched. All operations are
 * tenant-scoped and capture the reason + trigger event on the affected rows.
 */

/** Pre-send states an enrollment's steps can be in before they execute. */
const QUEUED_STATES = ['pending', 'scheduled', 'deferred'];
const QUEUED_OR_PAUSED = ['pending', 'scheduled', 'deferred', 'paused'];

export interface ReactiveControlInput {
  reason?: string;
  event?: string;
}

export type ReactiveAction = 'pause' | 'resume' | 'stop' | 'replace_cta';

/**
 * Pause an enrollment (e.g. the subject replied): move its queued steps to
 * 'paused' with the reason/event captured. Returns the number of steps paused.
 */
export async function pauseEnrollment(
  tenant_id: string,
  enrollment_id: string,
  input: ReactiveControlInput = {},
): Promise<number> {
  const rows = await dataService.rows<{ execution_step_id: string }>(
    `UPDATE sequence.execution_step
        SET status = 'paused', paused_at = now(),
            control_reason = $3, control_event = $4, updated_at = now()
      WHERE tenant_id = $1 AND enrollment_id = $2
        AND status = ANY($5::text[])
      RETURNING execution_step_id`,
    [tenant_id, enrollment_id, input.reason ?? null, input.event ?? null, QUEUED_STATES],
  );
  return rows.length;
}

/**
 * Resume a paused enrollment: 'paused' -> 'pending', re-arming next_run_at to
 * now when it was cleared. Returns the number of steps resumed.
 */
export async function resumeEnrollment(tenant_id: string, enrollment_id: string): Promise<number> {
  const rows = await dataService.rows<{ execution_step_id: string }>(
    `UPDATE sequence.execution_step
        SET status = 'pending',
            next_run_at = COALESCE(next_run_at, now()),
            paused_at = NULL, updated_at = now()
      WHERE tenant_id = $1 AND enrollment_id = $2 AND status = 'paused'
      RETURNING execution_step_id`,
    [tenant_id, enrollment_id],
  );
  return rows.length;
}

/**
 * Stop an enrollment (opt-out / payment / manual): cancel every still-queued or
 * paused step with the reason captured — no further touches will ever send.
 * Returns the number of steps canceled.
 */
export async function stopEnrollment(
  tenant_id: string,
  enrollment_id: string,
  input: ReactiveControlInput = {},
): Promise<number> {
  const rows = await dataService.rows<{ execution_step_id: string }>(
    `UPDATE sequence.execution_step
        SET status = 'canceled', canceled_at = now(),
            control_reason = $3, control_event = $4, updated_at = now()
      WHERE tenant_id = $1 AND enrollment_id = $2
        AND status = ANY($5::text[])
      RETURNING execution_step_id`,
    [tenant_id, enrollment_id, input.reason ?? null, input.event ?? null, QUEUED_OR_PAUSED],
  );
  return rows.length;
}

/**
 * Replace the call-to-action for an enrollment's upcoming steps: swap the
 * template on every still-queued/paused step, capturing the reason/event.
 * Returns the number of steps updated.
 */
export async function replaceCta(
  tenant_id: string,
  enrollment_id: string,
  input: { template_id: string } & ReactiveControlInput,
): Promise<number> {
  const rows = await dataService.rows<{ execution_step_id: string }>(
    `UPDATE sequence.execution_step
        SET template_id = $3,
            control_reason = $4, control_event = COALESCE($5, 'replace_cta'), updated_at = now()
      WHERE tenant_id = $1 AND enrollment_id = $2
        AND status = ANY($6::text[])
      RETURNING execution_step_id`,
    [tenant_id, enrollment_id, input.template_id, input.reason ?? null, input.event ?? null, QUEUED_OR_PAUSED],
  );
  return rows.length;
}
