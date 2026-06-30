/**
 * @projexlight/sdk-analytics — public surface.
 *
 * P6B v3.1 · ClickHouse OLAP (hot rollups ≤90d) + Iceberg/S3-tables
 * lakehouse for cold + cross-pool (partial G11; full federation P7).
 * Cohort / funnel / KPI primitives. Per-tenant rollups. Cross-pool
 * aggregation via warehouse only (no live cross-pool joins — FR-ANL-4).
 *
 * Initial drop: Postgres migration (specs + extract registry) + contracts.
 * Full rollup / query / extractToLakehouse executors land in follow-up
 * tasks under feat_analytics.
 */
export { migrationsDir } from './db';
export {
  buildFeatureWindows,
  createDatasetSpec,
  getDatasetSpec,
  listDatasetSpecs,
  buildDatasetFromSpec,
} from './services/datasetBuilder';
export type {
  BucketGrain,
  Aggregation,
  FeatureWindowSpec,
  FeatureWindowRow,
  DatasetSpecRecord,
  CreateDatasetSpecInput,
  DatasetBuildResult,
} from './services/datasetBuilder';
