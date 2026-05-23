import os from 'os';
import { dataService } from '@projexlight/db-runtime';
import { resumeRun } from './runtimeEngine';

/**
 * Durable polling worker for sdk-workflow.
 *
 * Why this exists: the in-process runner can't survive sleeps across pod
 * restarts and is single-pod by construction. We're NOT introducing Temporal
 * — it's a heavy external dependency — so we built a leveraged-locked
 * polling worker on top of the existing workflow.{run,step} schema.
 *
 * Architecture:
 *   - Every api-gateway pod calls startDurableWorker() at boot.
 *   - One pod at a time holds the LOCK_ID_DURABLE advisory lock for each
 *     tick; the rest no-op. Same pattern as sdk-approval slaTimer and
 *     sdk-data-rights schedulers.
 *   - The leader pod claims a batch of `status='paused' AND wake_at <= now()`
 *     runs using FOR UPDATE SKIP LOCKED inside a single UPDATE...RETURNING.
 *     That UPDATE atomically flips status to 'running' so no other tick (or
 *     other pod's executeRun) can also pick up the same row.
 *   - For each claimed run, we call resumeRun(run_id) which executes the
 *     remaining steps until the next sleep / completion / failure.
 *
 * The advisory lock prevents two pods from both ticking at the same instant
 * (which would still be safe due to SKIP LOCKED, but would cause every pod
 * to wake up and probe the DB on every interval — wasted load).
 */

// 0x57464C57 = "WFLW". Per-worker lock_id distinguishes this from any future
// workflow background workers in the same SDK.
const ADVISORY_NS = 0x57464c57;
const LOCK_ID_DURABLE = 1;

const WORKER_ID = `${os.hostname()}#${process.pid}`;

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

export interface DurableWorkerOptions {
  /** When false, startDurableWorker returns a no-op handle. */
  enabled: boolean;
  /** Poll cadence between tick attempts. 5_000 is a reasonable default. */
  intervalMs: number;
  /** Maximum number of paused runs claimed per tick. */
  batchSize: number;
}

export interface DurableWorkerHandle {
  stop(): void;
}

export interface DurableTickResult {
  /** Runs we claimed and called resumeRun on this tick. */
  resumed: number;
  /** Of those resumed, how many reached a terminal completed state. */
  completed: number;
  /** Of those resumed, how many failed (compensated/failed/terminated). */
  failed: number;
}

/**
 * Start the background polling worker. Idempotent across pods — only the
 * leader-locked pod does work per tick; others noop until they acquire the
 * lock on a future tick. Caller must invoke handle.stop() during pod
 * shutdown (e.g. fastify onClose hook).
 */
export function startDurableWorker(opts: DurableWorkerOptions): DurableWorkerHandle {
  if (!opts.enabled) return { stop: () => undefined };
  const timer = setInterval(() => {
    withLeaderLock(LOCK_ID_DURABLE, async () => {
      await runDurableTick(opts.batchSize);
    }).catch((err) => {
      console.error('[sdk-workflow] durable tick failed:', err);
    });
  }, opts.intervalMs);
  // Don't keep the event loop alive just for the worker — let normal shutdown
  // signals close the process cleanly.
  if (typeof timer.unref === 'function') timer.unref();
  return { stop: () => clearInterval(timer) };
}

/**
 * One tick of the durable worker:
 *   1. Atomically claim up to `batchSize` paused-and-due runs by flipping
 *      their status to 'running' under FOR UPDATE SKIP LOCKED.
 *   2. For each claimed run, call resumeRun(run_id) to execute remaining
 *      steps until next sleep / completion / failure.
 *   3. Tally outcomes for observability.
 *
 * Exported so tests can drive a tick deterministically without setInterval.
 * Safe to call directly even outside the leader lock — the SKIP LOCKED claim
 * is the actual race guard.
 */
export async function runDurableTick(batchSize: number): Promise<DurableTickResult> {
  // The claim query: FOR UPDATE SKIP LOCKED in the inner SELECT is what
  // prevents two workers from both claiming the same row. The outer UPDATE
  // also requires status='paused' AND wake_at <= now() as a belt-and-suspenders
  // guard against any stale id leaking from a prior tick.
  const claimed = await dataService.rows<{ run_id: string }>(
    `UPDATE workflow.run
        SET status     = 'running',
            claimed_by = $1,
            claimed_at = now()
      WHERE run_id IN (
        SELECT run_id FROM workflow.run
         WHERE status = 'paused'
           AND wake_at IS NOT NULL
           AND wake_at <= now()
         ORDER BY wake_at ASC
         LIMIT $2
         FOR UPDATE SKIP LOCKED
      )
      RETURNING run_id`,
    [WORKER_ID, batchSize],
  );

  let completed = 0;
  let failed = 0;

  for (const { run_id } of claimed) {
    try {
      const finalRun = await resumeRun(run_id);
      if (finalRun.status === 'completed') completed++;
      else if (
        finalRun.status === 'failed' ||
        finalRun.status === 'compensated' ||
        finalRun.status === 'terminated'
      ) {
        failed++;
      }
      // 'running' or 'paused' means the run is still alive — neither
      // completed nor failed; tally only resumed.
    } catch (err) {
      failed++;
      // Best-effort: leave the run in 'running' so the next tick won't
      // pick it up via wake_at — operator can inspect/replay manually.
      console.error(`[sdk-workflow] resumeRun failed for ${run_id}:`, err);
    }
  }

  return { resumed: claimed.length, completed, failed };
}
