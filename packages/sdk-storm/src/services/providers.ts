import type { StormProvider, StormKind, StormEventRef, StormIntensityCellRef } from '@projexlight/contracts';

/**
 * Weather provider adapter contract.
 *
 * Each adapter (NOAA, DTN, Weather Underground, synthetic) implements this
 * shape so the ingestor can fall back across providers per R-7 mitigation
 * (multi-provider fallback during post-storm peak demand). Adapters that
 * lack credentials must return `available: false` from `available()` so
 * the ingestor's chain skips them silently.
 */

export interface FetchWindow {
  /** ISO-8601 inclusive. */
  since: string;
  /** ISO-8601 exclusive. */
  until: string;
}

export interface ProviderEvent {
  provider_event_id: string;
  name: string;
  kind: StormKind;
  geom: unknown;
  started_at: string;
  ended_at: string | null;
  severity: string;
}

export interface ProviderIntensityCell {
  provider_event_id: string;
  cell_geom: unknown;
  wind_mph: number | null;
  hail_in: number | null;
  rainfall_in: number | null;
  gust_mph: number | null;
  captured_at: string;
}

export interface WeatherProviderAdapter {
  readonly provider: StormProvider | 'synthetic';
  available(): boolean;
  fetchEvents(window: FetchWindow): Promise<ProviderEvent[]>;
  fetchIntensityCells(providerEventId: string): Promise<ProviderIntensityCell[]>;
}

/**
 * NOAA adapter — primary public-data source for US storms. Free API; no
 * credentials, but the dev/staging surface uses NOAA_API_BASE override.
 * No-op without `NOAA_INGEST_ENABLED=true` so we don't hammer the API
 * during local dev unintentionally.
 */
export class NoaaAdapter implements WeatherProviderAdapter {
  readonly provider: StormProvider = 'noaa';
  available(): boolean {
    return process.env.NOAA_INGEST_ENABLED === 'true';
  }
  async fetchEvents(_window: FetchWindow): Promise<ProviderEvent[]> {
    // Real implementation: GET https://api.weather.gov/alerts/active
    // with optional ?start=&end= filtering. Parses GeoJSON polygons from
    // the alert payload, maps alert.event → StormKind, severity → severity.
    // Out of scope for this scaffold; returns empty so the chain falls
    // through to other providers.
    return [];
  }
  async fetchIntensityCells(_providerEventId: string): Promise<ProviderIntensityCell[]> {
    // Real: NWS Forecast endpoint by polygon. Returns gridded measurements.
    return [];
  }
}

/**
 * DTN adapter — paid provider used by insurance verticals for higher-res
 * hail/wind data. Requires DTN_API_KEY. No-op without it.
 */
export class DtnAdapter implements WeatherProviderAdapter {
  readonly provider: StormProvider = 'dtn';
  available(): boolean {
    return !!process.env.DTN_API_KEY;
  }
  async fetchEvents(_window: FetchWindow): Promise<ProviderEvent[]> {
    return [];
  }
  async fetchIntensityCells(_providerEventId: string): Promise<ProviderIntensityCell[]> {
    return [];
  }
}

/**
 * Weather Underground adapter — tertiary fallback (per R-7). Requires
 * WU_API_KEY. No-op without it.
 */
export class WeatherUndergroundAdapter implements WeatherProviderAdapter {
  readonly provider: StormProvider = 'weather-underground';
  available(): boolean {
    return !!process.env.WU_API_KEY;
  }
  async fetchEvents(_window: FetchWindow): Promise<ProviderEvent[]> {
    return [];
  }
  async fetchIntensityCells(_providerEventId: string): Promise<ProviderIntensityCell[]> {
    return [];
  }
}

/**
 * Synthetic adapter — generates deterministic test storms for dev/CI so
 * the end-to-end ingest pipeline + query path are exercised without
 * any external API dependency. Refuses to run in production unless
 * ALLOW_SYNTHETIC_STORM=true (matches the pattern from other synthetic
 * adapters in the platform — see api-gateway adapter registration).
 */
export class SyntheticStormAdapter implements WeatherProviderAdapter {
  readonly provider = 'synthetic' as const;
  available(): boolean {
    if (process.env.NODE_ENV === 'production' && process.env.ALLOW_SYNTHETIC_STORM !== 'true') {
      return false;
    }
    return true;
  }
  async fetchEvents(window: FetchWindow): Promise<ProviderEvent[]> {
    // One deterministic hail event per fetch window, footprint over Dallas.
    const id = `synthetic-${window.since.slice(0, 10)}`;
    return [
      {
        provider_event_id: id,
        name: `Synthetic Hail Swarm ${window.since.slice(0, 10)}`,
        kind: 'hail',
        geom: {
          type: 'Polygon',
          coordinates: [[
            [-97.0, 32.6], [-96.5, 32.6], [-96.5, 33.0], [-97.0, 33.0], [-97.0, 32.6],
          ]],
        },
        started_at: window.since,
        ended_at: window.until,
        severity: 'moderate',
      },
    ];
  }
  async fetchIntensityCells(providerEventId: string): Promise<ProviderIntensityCell[]> {
    // 4-cell grid over the synthetic footprint.
    const cells: ProviderIntensityCell[] = [];
    const baseLat = 32.6;
    const baseLng = -97.0;
    for (let i = 0; i < 4; i++) {
      const row = Math.floor(i / 2);
      const col = i % 2;
      cells.push({
        provider_event_id: providerEventId,
        cell_geom: {
          type: 'Polygon',
          coordinates: [[
            [baseLng + col * 0.25, baseLat + row * 0.2],
            [baseLng + (col + 1) * 0.25, baseLat + row * 0.2],
            [baseLng + (col + 1) * 0.25, baseLat + (row + 1) * 0.2],
            [baseLng + col * 0.25, baseLat + (row + 1) * 0.2],
            [baseLng + col * 0.25, baseLat + row * 0.2],
          ]],
        },
        wind_mph: 35 + i * 5,
        hail_in: 0.75 + i * 0.25,
        rainfall_in: 0.5,
        gust_mph: 55 + i * 5,
        captured_at: new Date().toISOString(),
      });
    }
    return cells;
  }
}

/**
 * Builds the adapter chain in fall-back order per PRD R-7.
 * Synthetic comes last so it's only used when all real providers are
 * unavailable — but it's also the one that always works in dev.
 */
export function buildProviderChain(): WeatherProviderAdapter[] {
  return [
    new NoaaAdapter(),
    new DtnAdapter(),
    new WeatherUndergroundAdapter(),
    new SyntheticStormAdapter(),
  ];
}

export type { StormEventRef, StormIntensityCellRef };
