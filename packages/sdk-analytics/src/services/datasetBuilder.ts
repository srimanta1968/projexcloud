import { dataService } from '@projexlight/db-runtime';

/**
 * Feature-window dataset builder (P12 · E1).
 *
 * Windows an asset's sensor time-series (asset.sensor_reading) into per-window
 * feature vectors for ML training — one row per time bucket, one column per
 * (sensor_id, aggregation). Specs are registered in analytics.dataset_spec and
 * each materialization is recorded in analytics.dataset_build for
 * reproducibility (lineage + export refs are filled in by later P12 tasks).
 */

export type BucketGrain = 'minute' | 'hour' | 'day';
export type Aggregation = 'avg' | 'min' | 'max' | 'last' | 'count';

const GRAINS = new Set<BucketGrain>(['minute', 'hour', 'day']);
const AGGS = new Set<Aggregation>(['avg', 'min', 'max', 'last', 'count']);
const DEFAULT_AGGS: Aggregation[] = ['avg', 'min', 'max', 'last', 'count'];

export interface FeatureWindowSpec {
  tenant_id: string;
  asset_id: string;
  sensor_ids?: string[];
  from: string;
  to: string;
  grain?: BucketGrain;
  aggregations?: Aggregation[];
}

export interface FeatureWindowRow {
  window_start: string;
  asset_id: string;
  /** "<sensor_id>.<aggregation>" -> value (null when no samples for that agg). */
  features: Record<string, number | null>;
}

interface RawBucketRow {
  sensor_id: string;
  bucket: string;
  n: string;
  min: number | null;
  max: number | null;
  avg: number | null;
  last: number | null;
}

/**
 * Build feature windows for an asset over [from, to). Reads the per-sensor
 * readings, aggregates per (sensor, bucket), and pivots into one feature row
 * per bucket. Returns rows ordered by window_start ascending.
 */
export async function buildFeatureWindows(spec: FeatureWindowSpec): Promise<FeatureWindowRow[]> {
  if (!spec.tenant_id) throw new Error('tenant_id is required');
  if (!spec.asset_id) throw new Error('asset_id is required');
  if (!spec.from || !spec.to) throw new Error('from and to are required');

  const grain: BucketGrain = spec.grain && GRAINS.has(spec.grain) ? spec.grain : 'minute';
  const aggregations = (spec.aggregations ?? DEFAULT_AGGS).filter((a) => AGGS.has(a));
  const aggs = aggregations.length > 0 ? aggregations : DEFAULT_AGGS;

  const params: unknown[] = [spec.asset_id, spec.tenant_id, spec.from, spec.to];
  let where =
    'asset_id = $1::uuid AND tenant_id = $2::uuid AND ts >= $3::timestamptz AND ts < $4::timestamptz';
  if (spec.sensor_ids && spec.sensor_ids.length > 0) {
    params.push(spec.sensor_ids);
    where += ` AND sensor_id = ANY($${params.length}::uuid[])`;
  }
  params.push(grain);
  const grainIdx = params.length;

  const rows = await dataService.rows<RawBucketRow>(
    `SELECT sensor_id::text AS sensor_id,
            date_trunc($${grainIdx}, ts) AS bucket,
            count(*)::text AS n,
            min(value) AS min, max(value) AS max, avg(value) AS avg,
            (array_agg(value ORDER BY ts DESC))[1] AS last
       FROM asset.sensor_reading
      WHERE ${where}
      GROUP BY sensor_id, bucket
      ORDER BY bucket ASC
      LIMIT 100000`,
    params,
  );

  const byBucket = new Map<string, FeatureWindowRow>();
  for (const r of rows) {
    const key = new Date(r.bucket).toISOString();
    let row = byBucket.get(key);
    if (!row) {
      row = { window_start: key, asset_id: spec.asset_id, features: {} };
      byBucket.set(key, row);
    }
    for (const a of aggs) {
      const raw = a === 'count' ? Number(r.n) : r[a];
      row.features[`${r.sensor_id}.${a}`] = raw == null ? null : Number(raw);
    }
  }
  return [...byBucket.values()];
}

/* ----------------------------------------------------------- dataset specs */

export interface DatasetSpecRecord {
  spec_id: string;
  tenant_id: string;
  name: string;
  asset_id: string;
  sensor_ids: string[] | null;
  bucket_grain: BucketGrain;
  aggregations: Aggregation[];
  label_source: Record<string, unknown> | null;
  created_at: string;
}

export interface CreateDatasetSpecInput {
  tenant_id: string;
  name: string;
  asset_id: string;
  sensor_ids?: string[];
  grain?: BucketGrain;
  aggregations?: Aggregation[];
  label_source?: Record<string, unknown>;
}

/** Register a reusable dataset spec. */
export async function createDatasetSpec(input: CreateDatasetSpecInput): Promise<DatasetSpecRecord> {
  if (!input.tenant_id) throw new Error('tenant_id is required');
  if (!input.name) throw new Error('name is required');
  if (!input.asset_id) throw new Error('asset_id is required');
  const grain: BucketGrain = input.grain && GRAINS.has(input.grain) ? input.grain : 'minute';
  const aggregations = (input.aggregations ?? DEFAULT_AGGS).filter((a) => AGGS.has(a));
  const row = await dataService.one<DatasetSpecRecord>(
    `INSERT INTO analytics.dataset_spec
       (tenant_id, name, asset_id, sensor_ids, bucket_grain, aggregations, label_source)
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)
     RETURNING spec_id::text, tenant_id::text, name, asset_id::text, sensor_ids,
               bucket_grain, aggregations, label_source, created_at`,
    [
      input.tenant_id,
      input.name,
      input.asset_id,
      input.sensor_ids ?? null,
      grain,
      aggregations.length > 0 ? aggregations : DEFAULT_AGGS,
      input.label_source ? JSON.stringify(input.label_source) : null,
    ],
  );
  if (!row) throw new Error('failed to persist dataset spec');
  return row;
}

/** Read a dataset spec by id, scoped to a tenant. */
export async function getDatasetSpec(tenant_id: string, spec_id: string): Promise<DatasetSpecRecord | null> {
  return dataService.one<DatasetSpecRecord>(
    `SELECT spec_id::text, tenant_id::text, name, asset_id::text, sensor_ids,
            bucket_grain, aggregations, label_source, created_at
       FROM analytics.dataset_spec
      WHERE tenant_id = $1::uuid AND spec_id = $2::uuid`,
    [tenant_id, spec_id],
  );
}

/** List dataset specs for a tenant. */
export async function listDatasetSpecs(tenant_id: string): Promise<DatasetSpecRecord[]> {
  return dataService.rows<DatasetSpecRecord>(
    `SELECT spec_id::text, tenant_id::text, name, asset_id::text, sensor_ids,
            bucket_grain, aggregations, label_source, created_at
       FROM analytics.dataset_spec
      WHERE tenant_id = $1::uuid
      ORDER BY created_at DESC`,
    [tenant_id],
  );
}

export interface DatasetBuildResult {
  build_id: string;
  spec_id: string;
  window_from: string;
  window_to: string;
  row_count: number;
  rows: FeatureWindowRow[];
}

/**
 * Materialize a registered spec over [from, to): build the feature windows and
 * record a dataset_build row. Returns the build metadata + the feature rows.
 */
export async function buildDatasetFromSpec(
  tenant_id: string,
  spec_id: string,
  window: { from: string; to: string },
): Promise<DatasetBuildResult | null> {
  const spec = await getDatasetSpec(tenant_id, spec_id);
  if (!spec) return null;

  const rows = await buildFeatureWindows({
    tenant_id,
    asset_id: spec.asset_id,
    sensor_ids: spec.sensor_ids ?? undefined,
    from: window.from,
    to: window.to,
    grain: spec.bucket_grain,
    aggregations: spec.aggregations,
  });

  const build = await dataService.one<{ build_id: string }>(
    `INSERT INTO analytics.dataset_build (spec_id, tenant_id, window_from, window_to, row_count)
     VALUES ($1, $2, $3::timestamptz, $4::timestamptz, $5)
     RETURNING build_id::text`,
    [spec_id, tenant_id, window.from, window.to, rows.length],
  );
  if (!build) throw new Error('failed to record dataset build');

  return {
    build_id: build.build_id,
    spec_id,
    window_from: window.from,
    window_to: window.to,
    row_count: rows.length,
    rows,
  };
}
