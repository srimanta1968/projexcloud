/**
 * @projexlight/sdk-storm — public surface.
 *
 * P7 · Storm overlays (pre/post-event) ingested from weather APIs (NOAA ·
 * DTN · Weather Underground per R-7); intensity grids per geo bbox;
 * historical archive; per-region storm event registry. Consumed by
 * sdk-lead-scoring (storm-impact subscore) and FieldOps verticals.
 *
 * Initial drop: Postgres migration + public-surface re-exports. Full
 * weather-API ingestor + per-bbox query lands in follow-up tasks under
 * feat_p7_storm.
 */
export { migrationsDir } from './db';
export type { StormEventRef, StormIntensityCellRef, StormKind, StormProvider } from '@projexlight/contracts';

// P7 FR-STM-1..4 — weather provider chain + ingestor + per-bbox query.
export {
  buildProviderChain,
  NoaaAdapter,
  DtnAdapter,
  WeatherUndergroundAdapter,
  SyntheticStormAdapter,
} from './services/providers';
export type {
  WeatherProviderAdapter,
  FetchWindow,
  ProviderEvent,
  ProviderIntensityCell,
} from './services/providers';
export { ingestOnce, startStormIngestor, queryByBbox } from './services/ingestor';
export type {
  IngestorRunResult,
  IngestorConfig,
  IngestorHandle,
  IngestorWorkerConfig,
  BboxQueryInput,
  BboxQueryResult,
} from './services/ingestor';
