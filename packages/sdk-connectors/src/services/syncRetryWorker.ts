import { dataService } from '@projexlight/db-runtime';
import { syncConnector } from './connectorsService';

/**
 * Connector sync retry/backoff worker + reconciliation (P15·E5).
 *
 * Modeled on sdk-webhook deliveryWorker/dlqReplay. Drains connectors.sync_deadletter:
 * due entries (status dlq/retrying, next_retry_at past) are re-driven through the
 * matching adapter; success -> 'resolved', failure -> exponential backoff and
 * re-queue, and once attempts reach max_attempts the entry is 'discarded'
 * (terminal — awaits manual continuation via replayDlq). This replaces the old
 * fail-once-with-409 behavior where a failed sync simply errored with no retry.
 *
 * Concurrency-safe: the due batch is claimed atomically with FOR UPDATE SKIP
 * LOCKED so multiple gateway pods never re-drive the same entry.
 */

/** Backoff schedule (seconds) indexed by the post-increment attempt number. */
const BACKOFF_SECONDS = [30, 120, 600, 3600, 21600, 86400];

export interface RetryWorkerOptions {
  enabled: boolean;
  intervalMs: number;
  batchSize: number;
}

export interface RetryTickResult {
  claimed: number;
  resolved: number;
  requeued: number;
  discarded: number;
}

interface ClaimedRow {
  deadletter_id: string;
  tenant_id: string;
  install_id: string | null;
  connector_kind: string;
  attempts: number;
  max_attempts: number;
}

/**
 * Start the background retry worker. No-op when disabled. Returns a stop handle.
 * Wire from the gateway boot behind CONNECTORS_RETRY_WORKER_ENABLED.
 */
export function startSyncRetryWorker(opts: RetryWorkerOptions): { stop: () => void } {
  if (!opts.enabled) return { stop: () => undefined };
  const timer = setInterval(() => {
    runRetryTick(opts.batchSize).catch((err) => {
      console.error('[sdk-connectors] retry worker tick failed:', (err as Error).message);
    });
  }, opts.intervalMs);
  // Do not keep the event loop alive solely for this timer.
  if (typeof timer.unref === 'function') timer.unref();
  return { stop: () => clearInterval(timer) };
}

/**
 * Run a single retry tick: claim up to `batchSize` due dead-letters, re-drive
 * each, and settle it (resolved / requeued with backoff / discarded).
 */
export async function runRetryTick(batchSize = 20): Promise<RetryTickResult> {
  const claimed = await dataService.rows<ClaimedRow>(
    `UPDATE connectors.sync_deadletter
        SET status = 'retrying', last_attempt_at = now(), updated_at = now()
      WHERE deadletter_id IN (
        SELECT deadletter_id FROM connectors.sync_deadletter
         WHERE status IN ('dlq','retrying')
           AND (next_retry_at IS NULL OR next_retry_at <= now())
         ORDER BY next_retry_at ASC NULLS FIRST
         LIMIT $1
         FOR UPDATE SKIP LOCKED
      )
      RETURNING deadletter_id, tenant_id, install_id, connector_kind, attempts, max_attempts`,
    [batchSize],
  );

  const result: RetryTickResult = { claimed: claimed.length, resolved: 0, requeued: 0, discarded: 0 };

  for (const row of claimed) {
    let ok = false;
    let failure = '';
    if (row.install_id) {
      try {
        await syncConnector(row.install_id);
        ok = true;
      } catch (err) {
        failure = (err as Error).message;
      }
    } else {
      // No install to re-drive against (e.g. install uninstalled). Cannot retry.
      failure = 'no install_id to re-drive';
    }

    if (ok) {
      await settleResolved(row.deadletter_id);
      result.resolved++;
      continue;
    }

    const nextAttempts = row.attempts + 1;
    if (!row.install_id || nextAttempts >= row.max_attempts) {
      await settleDiscarded(row.deadletter_id, failure);
      result.discarded++;
    } else {
      const backoff = BACKOFF_SECONDS[Math.min(nextAttempts, BACKOFF_SECONDS.length - 1)];
      await settleRequeue(row.deadletter_id, backoff, failure);
      result.requeued++;
    }
  }

  return result;
}

async function settleResolved(deadletter_id: string): Promise<void> {
  await dataService.query(
    `UPDATE connectors.sync_deadletter
        SET status = 'resolved', attempts = attempts + 1,
            resolved_at = now(), updated_at = now()
      WHERE deadletter_id = $1`,
    [deadletter_id],
  );
}

async function settleRequeue(deadletter_id: string, backoffSeconds: number, error: string): Promise<void> {
  await dataService.query(
    `UPDATE connectors.sync_deadletter
        SET status = 'dlq', attempts = attempts + 1,
            next_retry_at = now() + ($2 || ' seconds')::interval,
            error = $3, updated_at = now()
      WHERE deadletter_id = $1`,
    [deadletter_id, backoffSeconds, error.slice(0, 2000)],
  );
}

async function settleDiscarded(deadletter_id: string, error: string): Promise<void> {
  await dataService.query(
    `UPDATE connectors.sync_deadletter
        SET status = 'discarded', attempts = attempts + 1,
            error = $2, updated_at = now()
      WHERE deadletter_id = $1`,
    [deadletter_id, error.slice(0, 2000)],
  );
}

export interface ReconcileResult {
  superseded: number;
  requeued: number;
}

/**
 * Reconcile duplicate / partial DLQ state for a tenant (idempotent):
 *  - superseded: when several ACTIVE entries (dlq/retrying) share the same
 *    (install_id, sync_kind, external_ref), only the newest is kept; the older
 *    duplicates are marked 'resolved' (a later failure supersedes the earlier).
 *  - requeued: entries stuck in 'retrying' whose last_attempt_at is older than
 *    the stale window (default 1h) — a worker crashed mid-drive and left them
 *    partial. They are returned to 'dlq' with next_retry_at=now() so the retry
 *    worker re-drives them instead of leaving them wedged.
 *
 * (Orphaned-by-uninstall entries need no handling: sync_deadletter.install_id
 * is FK ON DELETE CASCADE, so uninstalling removes them automatically.)
 */
export async function reconcileSyncState(
  tenant_id: string,
  opts: { staleRetryingMs?: number } = {},
): Promise<ReconcileResult> {
  const staleMs = opts.staleRetryingMs ?? 3_600_000;

  const superseded = await dataService.rows<{ deadletter_id: string }>(
    `UPDATE connectors.sync_deadletter d
        SET status = 'resolved', resolved_at = now(), updated_at = now()
      WHERE d.tenant_id = $1
        AND d.status IN ('dlq','retrying')
        AND d.external_ref IS NOT NULL
        AND EXISTS (
          SELECT 1 FROM connectors.sync_deadletter n
           WHERE n.tenant_id = d.tenant_id
             AND n.status IN ('dlq','retrying')
             AND n.install_id IS NOT DISTINCT FROM d.install_id
             AND n.sync_kind  IS NOT DISTINCT FROM d.sync_kind
             AND n.external_ref = d.external_ref
             AND (n.first_failed_at, n.deadletter_id) > (d.first_failed_at, d.deadletter_id)
        )
      RETURNING d.deadletter_id`,
    [tenant_id],
  );

  const requeued = await dataService.rows<{ deadletter_id: string }>(
    `UPDATE connectors.sync_deadletter
        SET status = 'dlq', next_retry_at = now(), updated_at = now()
      WHERE tenant_id = $1
        AND status = 'retrying'
        AND last_attempt_at IS NOT NULL
        AND last_attempt_at < now() - ($2 || ' milliseconds')::interval
      RETURNING deadletter_id`,
    [tenant_id, staleMs],
  );

  return { superseded: superseded.length, requeued: requeued.length };
}
