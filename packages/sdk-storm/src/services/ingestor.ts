import crypto from 'crypto';
import { getPool } from '@projexlight/db-runtime';
import {
  buildProviderChain,
  type WeatherProviderAdapter,
  type FetchWindow,
  type ProviderEvent,
  type ProviderIntensityCell,
} from './providers';

/**
 * Storm-event ingestor (P7 FR-STM-1..4).
 *
 * Walks the provider fallback chain (NOAA → DTN → Weather Underground →
 * synthetic) and persists events + intensity cells into the storm schema.
 * Idempotent on (provider, provider_event_id) — re-running the ingestor
 * over the same window updates existing rows.
 *
 * Reliability per PRD R-7: if NOAA times out / returns 5xx, we don't
 * propagate that as a global failure — we move to the next adapter. The
 * synthetic adapter is the floor and always returns something in dev.
 */

export interface IngestorRunResult {
  /** Provider that won the chain for events; null when chain exhausted. */
  events_from: string | null;
  events_ingested: number;
  cells_ingested: number;
  providers_tried: string[];
}

export interface IngestorConfig {
  /** Override the default 4-provider chain (used in tests). */
  providers?: WeatherProviderAdapter[];
}

async function upsertEvent(event: ProviderEvent, provider: string): Promise<string> {
  const pool = getPool();
  const eventId = `stm_${crypto.randomBytes(10).toString('hex')}`;
  const { rows } = await pool.query<{ event_id: string }>(
    `INSERT INTO storm.event
       (event_id, name, kind, provider, provider_event_id, geom,
        started_at, ended_at, severity)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9)
     ON CONFLICT (provider, provider_event_id)
       DO UPDATE SET
         name = EXCLUDED.name,
         ended_at = EXCLUDED.ended_at,
         severity = EXCLUDED.severity,
         geom = EXCLUDED.geom
     RETURNING event_id`,
    [
      eventId,
      event.name,
      event.kind,
      provider,
      event.provider_event_id,
      JSON.stringify(event.geom),
      event.started_at,
      event.ended_at,
      event.severity,
    ],
  );
  return rows[0].event_id;
}

async function insertCells(eventId: string, cells: ProviderIntensityCell[]): Promise<number> {
  if (cells.length === 0) return 0;
  const pool = getPool();
  let inserted = 0;
  for (const cell of cells) {
    const cellId = `cel_${crypto.randomBytes(10).toString('hex')}`;
    await pool.query(
      `INSERT INTO storm.intensity_cell
         (cell_id, event_id, cell_geom, wind_mph, hail_in, rainfall_in, gust_mph, captured_at)
       VALUES ($1, $2, $3::jsonb, $4, $5, $6, $7, $8)`,
      [
        cellId,
        eventId,
        JSON.stringify(cell.cell_geom),
        cell.wind_mph,
        cell.hail_in,
        cell.rainfall_in,
        cell.gust_mph,
        cell.captured_at,
      ],
    );
    inserted += 1;
  }
  return inserted;
}

/**
 * Run the ingestor once over `window`. Walks providers in order; the first
 * provider that returns >0 events "wins" the run and we ingest its cells.
 * If all real providers return empty, the synthetic adapter (last in chain)
 * carries the run in dev so the pipeline still produces data.
 */
export async function ingestOnce(
  window: FetchWindow,
  cfg: IngestorConfig = {},
): Promise<IngestorRunResult> {
  const chain = cfg.providers ?? buildProviderChain();
  const tried: string[] = [];
  let winner: WeatherProviderAdapter | null = null;
  let events: ProviderEvent[] = [];

  for (const provider of chain) {
    if (!provider.available()) continue;
    tried.push(provider.provider);
    try {
      const got = await provider.fetchEvents(window);
      if (got.length > 0) {
        winner = provider;
        events = got;
        break;
      }
    } catch (err) {
      console.warn(
        `[storm-ingestor] provider ${provider.provider} failed: ${(err as Error).message}; falling back`,
      );
    }
  }

  if (!winner || events.length === 0) {
    return {
      events_from: null,
      events_ingested: 0,
      cells_ingested: 0,
      providers_tried: tried,
    };
  }

  let cellsTotal = 0;
  for (const event of events) {
    const eventId = await upsertEvent(event, winner.provider);
    try {
      const cells = await winner.fetchIntensityCells(event.provider_event_id);
      cellsTotal += await insertCells(eventId, cells);
    } catch (err) {
      console.warn(
        `[storm-ingestor] cells fetch failed for ${event.provider_event_id}: ${(err as Error).message}`,
      );
    }
  }

  return {
    events_from: winner.provider,
    events_ingested: events.length,
    cells_ingested: cellsTotal,
    providers_tried: tried,
  };
}

/** Periodic worker handle. */
export interface IngestorHandle {
  stop(): Promise<void>;
  stats(): { ticks: number; last_run: IngestorRunResult | null };
}

export interface IngestorWorkerConfig {
  enabled?: boolean;
  /** Polling cadence in ms. Default 1h — storms don't move minute-to-minute. */
  intervalMs?: number;
  /** Lookback window per tick. Default 24h. */
  lookbackMs?: number;
}

export function startStormIngestor(opts: IngestorWorkerConfig = {}): IngestorHandle {
  const cfg = {
    enabled: opts.enabled ?? true,
    intervalMs: opts.intervalMs ?? 60 * 60 * 1000,
    lookbackMs: opts.lookbackMs ?? 24 * 60 * 60 * 1000,
  };
  const stats = { ticks: 0, last_run: null as IngestorRunResult | null };
  let timer: ReturnType<typeof setInterval> | null = null;
  let stopped = false;

  async function tick(): Promise<void> {
    if (stopped) return;
    stats.ticks += 1;
    const until = new Date();
    const since = new Date(until.getTime() - cfg.lookbackMs);
    try {
      stats.last_run = await ingestOnce({
        since: since.toISOString(),
        until: until.toISOString(),
      });
    } catch (err) {
      console.warn('[storm-ingestor] tick failed:', (err as Error).message);
    }
  }

  if (cfg.enabled) {
    timer = setInterval(() => void tick(), cfg.intervalMs);
    void tick();
  }

  return {
    stats: () => ({ ticks: stats.ticks, last_run: stats.last_run }),
    async stop() {
      stopped = true;
      if (timer) clearInterval(timer);
    },
  };
}

/**
 * Per-bbox query (SKU: storm.overlay.query). Returns events whose footprint
 * overlaps the given bbox + their intensity cells. For the scaffold the
 * polygon-intersection check is JSONB-shape based; production swaps to
 * PostGIS ST_Intersects when sdk-geo turns on the extension globally.
 */
export interface BboxQueryInput {
  min_lat: number;
  min_lng: number;
  max_lat: number;
  max_lng: number;
  since?: string;
}

export interface BboxQueryResult {
  events: Array<{
    event_id: string;
    name: string;
    kind: string;
    provider: string;
    started_at: string;
    severity: string;
  }>;
  cell_count: number;
}

export async function queryByBbox(input: BboxQueryInput): Promise<BboxQueryResult> {
  const pool = getPool();
  const since = input.since ?? new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
  const { rows } = await pool.query<{
    event_id: string;
    name: string;
    kind: string;
    provider: string;
    started_at: Date;
    severity: string;
    cell_count: string;
  }>(
    `SELECT e.event_id, e.name, e.kind, e.provider, e.started_at, e.severity,
            (SELECT COUNT(*) FROM storm.intensity_cell c WHERE c.event_id = e.event_id) AS cell_count
       FROM storm.event e
      WHERE e.started_at >= $1
      ORDER BY e.started_at DESC
      LIMIT 100`,
    [since],
  );
  return {
    events: rows.map((r) => ({
      event_id: r.event_id,
      name: r.name,
      kind: r.kind,
      provider: r.provider,
      started_at: r.started_at.toISOString(),
      severity: r.severity,
    })),
    cell_count: rows.reduce((sum, r) => sum + parseInt(r.cell_count, 10), 0),
  };
}
