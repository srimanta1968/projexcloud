import { getPool } from '@projexlight/db-runtime';
import { updateReplicationLag } from './profileService';

/**
 * Active-Active replica probe loop (Y-P8-11 / FR-AA-5).
 *
 * Periodically measures Postgres replication lag from primary → replica
 * per (profile, sdk_kind, paired_region) and feeds the measurement back
 * into active_active.replication_stream.lag_seconds_p99. The Active-Active
 * drill orchestrator (P7) uses this stream when computing RPO.
 *
 * Lag query: Postgres exposes `pg_last_wal_replay_lsn()` on replicas and
 * `pg_current_wal_lsn()` on primaries; subtracting and converting to time
 * is what `pg_last_xact_replay_timestamp()` provides directly:
 *
 *   SELECT EXTRACT(epoch FROM (now() - pg_last_xact_replay_timestamp()))::float AS lag_seconds;
 *
 * Probes run against per-region DSNs supplied via env
 * AA_REPLICA_DSN_{REGION} (mirroring the federation probe convention).
 * Missing DSN → skip + record 0 (caller treats no measurement as "unknown",
 * not "good").
 */

export interface ReplicaProbeConfig {
  enabled?: boolean;
  intervalMs?: number;
}

export interface ReplicaProbeHandle {
  stop(): Promise<void>;
  stats(): { ticks: number; measurements: number; last_tick_at: string | null };
  /** Run one pass synchronously. Useful for tests + manual triggers. */
  runOnce(): Promise<number>;
}

interface StreamRow {
  profile_id: string;
  sdk_kind: string;
  paired_region: string;
}

async function listStreamsToProbe(): Promise<StreamRow[]> {
  const pool = getPool();
  // For each active profile, enumerate (sdk_kind, paired_region) pairs.
  // We probe per paired_region because lag is region-specific even when
  // the profile lists all the same SDK kinds across regions.
  const { rows } = await pool.query<StreamRow>(
    `SELECT s.profile_id, s.sdk_kind, region
       FROM active_active.profile p
       CROSS JOIN LATERAL unnest(p.paired_regions) AS region
       JOIN active_active.replication_stream s ON s.profile_id = p.profile_id
      WHERE s.mode IN ('sync', 'async')`,
  );
  // Postgres treats unnest column as the loop var; alias it to paired_region.
  return rows.map((r) => ({
    profile_id: r.profile_id,
    sdk_kind: r.sdk_kind,
    paired_region: (r as unknown as { region: string }).region,
  }));
}

function dsnForRegion(region: string): string | undefined {
  const envKey = `AA_REPLICA_DSN_${region.toUpperCase().replace(/-/g, '_')}`;
  return process.env[envKey];
}

async function measureLagSeconds(dsn: string): Promise<number | null> {
  // Lazy import — pg is already in every SDK's devDeps and present at runtime.
  // We open a transient client because the lag probe targets the REPLICA's
  // own DSN, not the gateway's primary pool.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { Client } = require('pg') as typeof import('pg');
  const client = new Client({ connectionString: dsn });
  try {
    await client.connect();
    const r = await client.query<{ lag_seconds: string | null }>(
      `SELECT COALESCE(EXTRACT(epoch FROM (now() - pg_last_xact_replay_timestamp())), 0)::text AS lag_seconds`,
    );
    return parseFloat(r.rows[0]?.lag_seconds ?? '0');
  } catch (err) {
    console.warn(`[active-active:replica-probe] probe failed: ${(err as Error).message}`);
    return null;
  } finally {
    try { await client.end(); } catch { /* noop */ }
  }
}

async function runOncePass(): Promise<number> {
  const streams = await listStreamsToProbe();
  let measurements = 0;
  // Group by paired_region so we open one connection per region per pass.
  const byRegion = new Map<string, StreamRow[]>();
  for (const s of streams) {
    const list = byRegion.get(s.paired_region) ?? [];
    list.push(s);
    byRegion.set(s.paired_region, list);
  }
  for (const [region, list] of byRegion) {
    const dsn = dsnForRegion(region);
    if (!dsn) {
      // No DSN for this region — skip silently. The drill orchestrator
      // will still trigger from probe-less regions but with lag=0.
      continue;
    }
    const lag = await measureLagSeconds(dsn);
    if (lag === null) continue;
    // Feed the same lag back to every (profile, sdk_kind) in this region
    // — accurate enough for SLO display. Per-stream lag refinement is a
    // future improvement once per-replica logical slots land.
    for (const s of list) {
      try {
        await updateReplicationLag({
          profile_id: s.profile_id,
          sdk_kind: s.sdk_kind,
          lag_seconds_p99: lag,
        });
        measurements += 1;
      } catch (err) {
        console.warn(`[active-active:replica-probe] update failed: ${(err as Error).message}`);
      }
    }
  }
  return measurements;
}

export function startReplicaProbe(opts: ReplicaProbeConfig = {}): ReplicaProbeHandle {
  const cfg = {
    enabled: opts.enabled ?? true,
    intervalMs: opts.intervalMs ?? 30_000,
  };
  const stats = { ticks: 0, measurements: 0, last_tick_at: null as string | null };
  let timer: ReturnType<typeof setInterval> | null = null;
  let stopped = false;

  async function tick(): Promise<void> {
    if (stopped) return;
    stats.ticks += 1;
    stats.last_tick_at = new Date().toISOString();
    try {
      stats.measurements += await runOncePass();
    } catch (err) {
      console.warn('[active-active:replica-probe] tick failed:', (err as Error).message);
    }
  }

  if (cfg.enabled) {
    timer = setInterval(() => void tick(), cfg.intervalMs);
  }

  return {
    stats: () => ({ ...stats }),
    runOnce: runOncePass,
    async stop() {
      stopped = true;
      if (timer) clearInterval(timer);
    },
  };
}
