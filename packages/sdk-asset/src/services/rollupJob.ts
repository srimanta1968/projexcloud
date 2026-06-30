import { getClickHouse } from '@projexlight/clickhouse-runtime';

/**
 * Sensor rollup/downsample job (P12 · E1) — the meter-collector decoupling
 * pattern applied to the digital-twin telemetry tier.
 *
 * The 1m rollup is kept current in real time by the `asset.sensor_reading_1m_mv`
 * materialized view (raw → 1m on insert). This background job owns the 1h tier
 * and the *backfill* path, off the hot ingest path:
 *
 *   - rebuild1h(window): recompute the 1h rollup from the 1m tier for a window
 *     (delete-then-reinsert → idempotent; safe to re-run / overlap).
 *   - backfill1m(window): recompute the 1m rollup directly from raw for a window
 *     — used for historical/replayed data the streaming MV never saw.
 *   - runSensorRollup(window): backfill 1m then rebuild 1h for the window.
 *   - startSensorRollupJob(): periodic catch-up over a trailing window.
 *
 * All ClickHouse-only; callers must have called initClickHouse() first.
 */

export interface RollupWindow {
  /** ISO datetime, inclusive lower bound. */
  from: string;
  /** ISO datetime, exclusive upper bound. */
  to: string;
}

export interface RollupResult {
  from: string;
  to: string;
  rebuilt_1m: boolean;
  rebuilt_1h: boolean;
}

const ROLLUP_INTERVAL_MS = parseInt(process.env.ASSET_ROLLUP_INTERVAL_MS || '300000', 10); // 5m
const ROLLUP_TRAILING_HOURS = parseInt(process.env.ASSET_ROLLUP_TRAILING_HOURS || '3', 10);

/** ClickHouse DateTime literal (UTC, second precision) from an ISO string. */
function chDateTime(iso: string): string {
  return new Date(iso).toISOString().replace('T', ' ').replace(/\.\d+Z$/, '').replace('Z', '');
}

/** Floor an ISO datetime to the start of its hour (UTC). */
function floorHourIso(iso: string): string {
  const d = new Date(iso);
  d.setUTCMinutes(0, 0, 0);
  return d.toISOString();
}

/** Recompute the 1m rollup from raw readings for [from, to). Idempotent. */
export async function backfill1m(window: RollupWindow): Promise<void> {
  const ch = getClickHouse();
  const from = chDateTime(window.from);
  const to = chDateTime(window.to);
  await ch.command({
    query: `ALTER TABLE asset.sensor_reading_1m DELETE
            WHERE bucket >= toDateTime('${from}') AND bucket < toDateTime('${to}')`,
  });
  await ch.command({
    query: `INSERT INTO asset.sensor_reading_1m
            SELECT toStartOfMinute(ts) AS bucket, tenant_id, asset_id, sensor_id, unit,
                   countState() AS cnt, minState(value) AS min_v, maxState(value) AS max_v,
                   avgState(value) AS avg_v, argMaxState(value, ts) AS last_v
            FROM asset.sensor_reading
            WHERE ts >= toDateTime64('${from}', 3) AND ts < toDateTime64('${to}', 3)
            GROUP BY bucket, tenant_id, asset_id, sensor_id, unit`,
  });
}

/** Recompute the 1h rollup from the 1m tier for [floorHour(from), to). Idempotent. */
export async function rebuild1h(window: RollupWindow): Promise<void> {
  const ch = getClickHouse();
  const from = chDateTime(floorHourIso(window.from));
  const to = chDateTime(window.to);
  await ch.command({
    query: `ALTER TABLE asset.sensor_reading_1h DELETE
            WHERE bucket >= toDateTime('${from}') AND bucket < toDateTime('${to}')`,
  });
  await ch.command({
    query: `INSERT INTO asset.sensor_reading_1h
            SELECT toStartOfHour(bucket) AS bucket, tenant_id, asset_id, sensor_id, unit,
                   countMergeState(cnt) AS cnt, minMergeState(min_v) AS min_v,
                   maxMergeState(max_v) AS max_v, avgMergeState(avg_v) AS avg_v,
                   argMaxMergeState(last_v) AS last_v
            FROM asset.sensor_reading_1m
            WHERE bucket >= toDateTime('${from}') AND bucket < toDateTime('${to}')
            GROUP BY bucket, tenant_id, asset_id, sensor_id, unit`,
  });
}

/** Backfill 1m then rebuild 1h for a window. Decoupled from the ingest hot path. */
export async function runSensorRollup(window: RollupWindow): Promise<RollupResult> {
  await backfill1m(window);
  await rebuild1h(window);
  return { from: window.from, to: window.to, rebuilt_1m: true, rebuilt_1h: true };
}

/**
 * Start the periodic catch-up loop: every ASSET_ROLLUP_INTERVAL_MS, re-roll the
 * trailing ASSET_ROLLUP_TRAILING_HOURS window. Idempotent each pass. Returns a
 * stop function. Failures are logged and never crash the loop.
 */
export function startSensorRollupJob(): () => void {
  let stopped = false;
  const tick = async (): Promise<void> => {
    if (stopped) return;
    const to = new Date();
    const from = new Date(to.getTime() - ROLLUP_TRAILING_HOURS * 60 * 60 * 1000);
    try {
      await runSensorRollup({ from: from.toISOString(), to: to.toISOString() });
    } catch (err) {
      console.warn('[sdk-asset] sensor rollup tick failed:', (err as Error).message);
    }
  };
  const timer = setInterval(() => { void tick(); }, ROLLUP_INTERVAL_MS);
  if (typeof timer.unref === 'function') timer.unref();
  void tick();
  return () => {
    stopped = true;
    clearInterval(timer);
  };
}
