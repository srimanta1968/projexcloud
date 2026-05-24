import { getPool } from '@projexlight/db-runtime';

/**
 * Per-encounter retention shredder (P7 FR-EVD-6 / AC-12).
 *
 * Periodically scans evidence.capture for rows whose retention_expires_at
 * has passed and flips them from 'active' to 'shredded'. Uses SELECT FOR
 * UPDATE SKIP LOCKED so multiple workers (one per api-gateway replica) can
 * drain the queue concurrently without conflict.
 *
 * What this does:
 *   - Marks status='shredded' on expired captures
 *   - Emits evidence.shredded.v1 envelope per capture
 *   - Records stats for the /metrics endpoint
 *
 * What this does NOT do (deferred):
 *   - Actual S3 blob deletion. sdk-media owns the blob store; this worker
 *     fires the event and sdk-media's listener handles the destructive op.
 *     Keeps the destructive blast radius in one place and lets retention
 *     re-runs be idempotent (status flip is the only DB write here).
 *   - Chain-of-custody 'shredded' append. The chain enum doesn't include
 *     'shredded' as an action today; if/when we add it, this is the
 *     producer.
 */

export interface ShredderConfig {
  /** Default true; set false to noop the worker (used in tests). */
  enabled?: boolean;
  /** Polling cadence in ms. Default 5 minutes — retention is not latency-sensitive. */
  intervalMs?: number;
  /** Rows to claim per tick. Default 100. */
  batchSize?: number;
}

export interface ShredderStats {
  ticks: number;
  shredded_total: number;
  errors_total: number;
  last_tick_at: string | null;
  last_shredded_at: string | null;
}

export interface ShredderHandle {
  stats(): ShredderStats;
  /** Run one drain cycle synchronously. Returns the number of rows shredded. */
  drainOnce(): Promise<number>;
  stop(): Promise<void>;
}

export const DEFAULT_SHREDDER_CONFIG: Required<ShredderConfig> = {
  enabled: true,
  intervalMs: 5 * 60 * 1000,
  batchSize: 100,
};

/**
 * Emitter hook — gateway-installed. When not registered, events are
 * dropped (logged) so unit tests don't need a Kafka stub.
 */
export type ShredEventEmitter = (event: {
  event_type: 'evidence.shredded.v1';
  capture_id: string;
  tenant_id: string;
  encounter_id: string;
  retention_class: string;
  shredded_at: string;
}) => Promise<void> | void;

let _emitter: ShredEventEmitter = (event) => {
  console.log(
    `[retention-shredder] would emit evidence.shredded.v1 capture=${event.capture_id} (no emitter registered)`,
  );
};

export function setShredEmitter(emitter: ShredEventEmitter): void {
  _emitter = emitter;
}

/**
 * One drain cycle. Returns the number of rows marked shredded. Safe to
 * call from a cron, an admin button, or the periodic worker below.
 */
export async function drainOnce(batchSize: number = DEFAULT_SHREDDER_CONFIG.batchSize): Promise<number> {
  const pool = getPool();
  const client = await pool.connect();
  let shredded: Array<{
    capture_id: string;
    tenant_id: string;
    encounter_id: string;
    retention_class: string;
  }> = [];

  try {
    await client.query('BEGIN');
    // Claim rows. SKIP LOCKED keeps replicas independent.
    const claimed = await client.query<{
      capture_id: string;
      tenant_id: string;
      encounter_id: string;
      retention_class: string;
    }>(
      `SELECT capture_id, tenant_id::text AS tenant_id,
              encounter_id::text AS encounter_id, retention_class
         FROM evidence.capture
        WHERE status = 'active'
          AND retention_expires_at IS NOT NULL
          AND retention_expires_at <= now()
        ORDER BY retention_expires_at ASC
        LIMIT $1
        FOR UPDATE SKIP LOCKED`,
      [batchSize],
    );

    if (claimed.rows.length === 0) {
      await client.query('COMMIT');
      return 0;
    }

    const ids = claimed.rows.map((r) => r.capture_id);
    await client.query(
      `UPDATE evidence.capture SET status = 'shredded' WHERE capture_id = ANY($1::text[])`,
      [ids],
    );
    await client.query('COMMIT');
    shredded = claimed.rows;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }

  // Emit events outside the transaction — best-effort, never roll back
  // a successful status flip because an emitter blip.
  const now = new Date().toISOString();
  for (const row of shredded) {
    try {
      await _emitter({
        event_type: 'evidence.shredded.v1',
        capture_id: row.capture_id,
        tenant_id: row.tenant_id,
        encounter_id: row.encounter_id,
        retention_class: row.retention_class,
        shredded_at: now,
      });
    } catch (err) {
      console.warn(
        `[retention-shredder] emit failed for capture ${row.capture_id}: ${(err as Error).message}`,
      );
    }
  }

  return shredded.length;
}

/**
 * Start the periodic worker. Returns a handle for graceful shutdown +
 * /metrics exposure.
 */
export function startRetentionShredder(opts: ShredderConfig = {}): ShredderHandle {
  const cfg = { ...DEFAULT_SHREDDER_CONFIG, ...opts };
  const stats: ShredderStats = {
    ticks: 0,
    shredded_total: 0,
    errors_total: 0,
    last_tick_at: null,
    last_shredded_at: null,
  };

  let timer: ReturnType<typeof setInterval> | null = null;
  let stopped = false;

  async function tick(): Promise<void> {
    if (stopped) return;
    stats.ticks += 1;
    stats.last_tick_at = new Date().toISOString();
    try {
      const n = await drainOnce(cfg.batchSize);
      stats.shredded_total += n;
      if (n > 0) stats.last_shredded_at = stats.last_tick_at;
    } catch (err) {
      stats.errors_total += 1;
      console.warn('[retention-shredder] tick failed:', (err as Error).message);
    }
  }

  if (cfg.enabled) {
    timer = setInterval(() => void tick(), cfg.intervalMs);
    // Kick off a first tick immediately so a freshly-restarted gateway
    // doesn't sit on an expired-retention backlog for a full interval.
    void tick();
  }

  return {
    stats: () => ({ ...stats }),
    drainOnce: () => drainOnce(cfg.batchSize),
    async stop() {
      stopped = true;
      if (timer) clearInterval(timer);
    },
  };
}
