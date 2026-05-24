import { getPool } from '@projexlight/db-runtime';
import { ingestLeakAlert } from './regionService';

/**
 * Attestation expiry watcher (Y-P8-5 / FR-SOV-7).
 *
 * Periodically scans sovereign.attestation for rows whose expires_at has
 * passed and:
 *   1. Updates the owning region_config.attestation_state to 'expired'.
 *   2. Emits a critical leak_monitor_alert (kind=policy-violation) so
 *      the region's expired attestation is visible on the ops dashboard
 *      until a fresh attestation is issued.
 *
 * Idempotent: only flips rows whose attestation_state isn't already
 * 'expired'. Cheap query — runs hourly by default.
 */

export interface ExpiryWatcherConfig {
  enabled?: boolean;
  /** Polling cadence in ms. Default 1h. */
  intervalMs?: number;
}

export interface ExpiryWatcherHandle {
  stop(): Promise<void>;
  stats(): { ticks: number; expired_total: number; last_tick_at: string | null };
  /** Run one pass synchronously. Useful in tests and from admin endpoints. */
  runOnce(): Promise<number>;
}

async function expireOnePass(): Promise<number> {
  const pool = getPool();
  const { rows } = await pool.query<{ region_id: string }>(
    `WITH expired AS (
       SELECT DISTINCT a.region_id
         FROM sovereign.attestation a
         JOIN sovereign.region_config r ON r.region_id = a.region_id
        WHERE a.expires_at < now()
          AND r.attestation_state <> 'expired'
     )
     UPDATE sovereign.region_config r
        SET attestation_state = 'expired'
       FROM expired e
      WHERE r.region_id = e.region_id
     RETURNING r.region_id`,
  );
  // Emit a critical alert per newly-expired region so dashboards page ops.
  for (const row of rows) {
    try {
      await ingestLeakAlert({
        region_id: row.region_id,
        kind: 'policy-violation',
        severity: 'critical',
        incident_ref: `attestation-expired-${row.region_id}-${new Date().toISOString().slice(0, 10)}`,
      });
    } catch (err) {
      console.warn(
        `[sovereign:expiry-watcher] alert ingest failed for ${row.region_id}: ${(err as Error).message}`,
      );
    }
  }
  return rows.length;
}

export function startAttestationExpiryWatcher(opts: ExpiryWatcherConfig = {}): ExpiryWatcherHandle {
  const cfg = {
    enabled: opts.enabled ?? true,
    intervalMs: opts.intervalMs ?? 60 * 60 * 1000,
  };
  const stats = { ticks: 0, expired_total: 0, last_tick_at: null as string | null };
  let timer: ReturnType<typeof setInterval> | null = null;
  let stopped = false;

  async function tick(): Promise<void> {
    if (stopped) return;
    stats.ticks += 1;
    stats.last_tick_at = new Date().toISOString();
    try {
      const n = await expireOnePass();
      stats.expired_total += n;
      if (n > 0) {
        console.log(`[sovereign:expiry-watcher] flipped ${n} region(s) to attestation_state=expired`);
      }
    } catch (err) {
      console.warn('[sovereign:expiry-watcher] tick failed:', (err as Error).message);
    }
  }

  if (cfg.enabled) {
    timer = setInterval(() => void tick(), cfg.intervalMs);
    // Run once immediately so a freshly-restarted gateway doesn't sit on
    // a backlog of expired attestations for a full hour.
    void tick();
  }

  return {
    stats: () => ({ ...stats }),
    runOnce: expireOnePass,
    async stop() {
      stopped = true;
      if (timer) clearInterval(timer);
    },
  };
}
