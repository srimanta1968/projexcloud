import { dataService } from '@projexlight/db-runtime';
import type { EndpointRecord } from '../models/webhook.model';

/**
 * Circuit breaker per FR-WHK-5.
 *
 * Per-endpoint state machine:
 *   closed (status='active')
 *     ├─ on FAILURE_THRESHOLD consecutive failures → open (status='circuit-open')
 *     └─ on success                                → reset failure_streak to 0
 *   open (status='circuit-open')
 *     └─ after HALF_OPEN_AFTER_MS                  → admit ONE probe call;
 *                                                    on success → closed; on
 *                                                    failure → stay open with
 *                                                    last_failure_at refreshed
 *
 * Knobs are env-overridable so ops can tune per environment without redeploy.
 */

const FAILURE_THRESHOLD = parseInt(process.env.WEBHOOK_BREAKER_FAILURE_THRESHOLD ?? '10', 10);
const HALF_OPEN_AFTER_MS = parseInt(process.env.WEBHOOK_BREAKER_HALF_OPEN_AFTER_MS ?? '60000', 10);

export async function recordSuccess(endpoint_id: string): Promise<void> {
  await dataService.query(
    `UPDATE webhook.endpoint
        SET failure_streak = 0,
            status = 'active',
            last_success_at = now()
      WHERE endpoint_id = $1`,
    [endpoint_id],
  );
}

export async function recordFailure(endpoint_id: string): Promise<void> {
  await dataService.query(
    `UPDATE webhook.endpoint
        SET failure_streak = failure_streak + 1,
            last_failure_at = now(),
            status = CASE
              WHEN failure_streak + 1 >= $2 THEN 'circuit-open'
              ELSE status
            END
      WHERE endpoint_id = $1`,
    [endpoint_id, FAILURE_THRESHOLD],
  );
}

/**
 * Should the worker attempt this delivery? Returns true if endpoint is
 * 'active' OR if it's 'circuit-open' but enough time has passed for a
 * half-open probe.
 */
export function shouldAttempt(endpoint: EndpointRecord): boolean {
  if (endpoint.status === 'paused') return false;
  if (endpoint.status === 'active') return true;
  // circuit-open: probe after HALF_OPEN_AFTER_MS since last failure.
  if (!endpoint.last_failure_at) return true; // shouldn't happen but be safe
  const since = Date.now() - new Date(endpoint.last_failure_at).getTime();
  return since >= HALF_OPEN_AFTER_MS;
}
