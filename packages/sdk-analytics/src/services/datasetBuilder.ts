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

/* --------------------------------------------------- labeling (supervised) */

export type LabelValue = number | string;

export interface IntervalLabel {
  from: string;
  to: string;
  label: LabelValue;
}

/**
 * How to label feature windows for supervised training:
 *   - 'intervals': inline labeled time ranges (e.g. "these windows were a fault").
 *   - 'provider':  delegate to a pluggable label provider the host wires to
 *                  sdk-event / sdk-evidence (join events/evidence to windows).
 */
export interface LabelSource {
  kind: 'intervals' | 'provider';
  intervals?: IntervalLabel[];
  default_label?: LabelValue;
  /** Opaque args passed to the label provider (provider kind). */
  provider_args?: Record<string, unknown>;
}

export interface LabeledFeatureRow extends FeatureWindowRow {
  label: LabelValue | null;
  labeled: boolean;
}

export interface LabelProviderContext {
  tenant_id: string;
  asset_id: string;
  from: string;
  to: string;
  window_starts: string[];
  args?: Record<string, unknown>;
}

/** Returns a map of window_start(ISO) -> label. Wired by the host to events/evidence. */
export type LabelProvider = (ctx: LabelProviderContext) => Promise<Record<string, LabelValue>>;

let _labelProvider: LabelProvider | null = null;
export function setLabelProvider(provider: LabelProvider | null): void {
  _labelProvider = provider;
}
export function _resetLabelProvider(): void {
  _labelProvider = null;
}

/**
 * Attach a label to each feature window. For 'intervals', a window is labeled
 * when its start falls within a labeled interval; otherwise default_label. For
 * 'provider', the wired provider supplies labels (join with events/evidence);
 * if no provider is wired, rows fall back to default_label / unlabeled.
 */
export async function labelFeatureWindows(
  rows: FeatureWindowRow[],
  source: LabelSource,
  ctx: { tenant_id: string; asset_id: string; from: string; to: string },
): Promise<LabeledFeatureRow[]> {
  const defaultLabel = source.default_label ?? null;

  if (source.kind === 'provider') {
    let map: Record<string, LabelValue> = {};
    if (_labelProvider) {
      map = await _labelProvider({
        tenant_id: ctx.tenant_id,
        asset_id: ctx.asset_id,
        from: ctx.from,
        to: ctx.to,
        window_starts: rows.map((r) => r.window_start),
        args: source.provider_args,
      });
    }
    return rows.map((r) => {
      const has = Object.prototype.hasOwnProperty.call(map, r.window_start);
      const label = has ? map[r.window_start] : defaultLabel;
      return { ...r, label, labeled: has };
    });
  }

  // intervals
  const intervals = (source.intervals ?? []).map((iv) => ({
    from: new Date(iv.from).getTime(),
    to: new Date(iv.to).getTime(),
    label: iv.label,
  }));
  return rows.map((r) => {
    const t = new Date(r.window_start).getTime();
    const hit = intervals.find((iv) => t >= iv.from && t < iv.to);
    return { ...r, label: hit ? hit.label : defaultLabel, labeled: !!hit };
  });
}

/* ------------------------------------------------ lineage / reproducibility */

export interface DatasetLineageContext {
  tenant_id: string;
  asset_id: string;
  spec_id: string;
  build_id: string;
  window_from: string;
  window_to: string;
  row_count: number;
}

/**
 * Records the provenance of a dataset build (dataset derived_from the asset's
 * sensor data) and returns a lineage_ref. Wired by the host to sdk-lineage.emit
 * so sdk-analytics stays free of a hard sdk-lineage dep.
 */
export type DatasetLineageRecorder = (ctx: DatasetLineageContext) => Promise<string | null>;

let _lineageRecorder: DatasetLineageRecorder | null = null;
export function setDatasetLineageRecorder(recorder: DatasetLineageRecorder | null): void {
  _lineageRecorder = recorder;
}
export function _resetDatasetLineageRecorder(): void {
  _lineageRecorder = null;
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

/** Set/replace the labeling source on a spec (turns it into a supervised dataset). */
export async function updateDatasetLabelSource(
  tenant_id: string,
  spec_id: string,
  label_source: LabelSource | null,
): Promise<DatasetSpecRecord | null> {
  return dataService.one<DatasetSpecRecord>(
    `UPDATE analytics.dataset_spec
        SET label_source = $3::jsonb
      WHERE tenant_id = $1::uuid AND spec_id = $2::uuid
     RETURNING spec_id::text, tenant_id::text, name, asset_id::text, sensor_ids,
               bucket_grain, aggregations, label_source, created_at`,
    [tenant_id, spec_id, label_source ? JSON.stringify(label_source) : null],
  );
}

export interface DatasetBuildResult {
  build_id: string;
  spec_id: string;
  window_from: string;
  window_to: string;
  row_count: number;
  labeled_count: number;
  lineage_ref: string | null;
  rows: Array<FeatureWindowRow | LabeledFeatureRow>;
}

/**
 * Materialize a registered spec over [from, to): build the feature windows,
 * apply the spec's label source (if any) joining events/evidence for supervised
 * datasets, and record a dataset_build row. Returns the build metadata + rows.
 */
export async function buildDatasetFromSpec(
  tenant_id: string,
  spec_id: string,
  window: { from: string; to: string },
): Promise<DatasetBuildResult | null> {
  const spec = await getDatasetSpec(tenant_id, spec_id);
  if (!spec) return null;

  const baseRows = await buildFeatureWindows({
    tenant_id,
    asset_id: spec.asset_id,
    sensor_ids: spec.sensor_ids ?? undefined,
    from: window.from,
    to: window.to,
    grain: spec.bucket_grain,
    aggregations: spec.aggregations,
  });

  let rows: Array<FeatureWindowRow | LabeledFeatureRow> = baseRows;
  let labeled_count = 0;
  if (spec.label_source) {
    const labeled = await labelFeatureWindows(baseRows, spec.label_source as unknown as LabelSource, {
      tenant_id,
      asset_id: spec.asset_id,
      from: window.from,
      to: window.to,
    });
    rows = labeled;
    labeled_count = labeled.filter((r) => r.labeled).length;
  }

  const build = await dataService.one<{ build_id: string }>(
    `INSERT INTO analytics.dataset_build
       (spec_id, tenant_id, window_from, window_to, row_count, labeled_count)
     VALUES ($1, $2, $3::timestamptz, $4::timestamptz, $5, $6)
     RETURNING build_id::text`,
    [spec_id, tenant_id, window.from, window.to, rows.length, labeled_count],
  );
  if (!build) throw new Error('failed to record dataset build');

  // Provenance: record the dataset-derived-from-asset edge (reproducibility).
  let lineage_ref: string | null = null;
  if (_lineageRecorder) {
    try {
      lineage_ref = await _lineageRecorder({
        tenant_id,
        asset_id: spec.asset_id,
        spec_id,
        build_id: build.build_id,
        window_from: window.from,
        window_to: window.to,
        row_count: rows.length,
      });
      if (lineage_ref) {
        await dataService.rows(
          `UPDATE analytics.dataset_build SET lineage_ref = $2 WHERE build_id = $1::uuid`,
          [build.build_id, lineage_ref],
        );
      }
    } catch (err) {
      console.warn('[sdk-analytics] lineage recorder failed:', (err as Error).message);
    }
  }

  return {
    build_id: build.build_id,
    spec_id,
    window_from: window.from,
    window_to: window.to,
    row_count: rows.length,
    labeled_count,
    lineage_ref,
    rows,
  };
}

export interface DatasetBuildRecord {
  build_id: string;
  spec_id: string;
  tenant_id: string;
  window_from: string;
  window_to: string;
  row_count: number;
  labeled_count: number;
  lineage_ref: string | null;
  export_ref: string | null;
  built_at: string;
}

/** List builds for a spec (reproducibility ledger: window + lineage_ref per build). */
export async function listDatasetBuilds(tenant_id: string, spec_id: string): Promise<DatasetBuildRecord[]> {
  return dataService.rows<DatasetBuildRecord>(
    `SELECT build_id::text, spec_id::text, tenant_id::text, window_from, window_to,
            row_count, labeled_count, lineage_ref, export_ref, built_at
       FROM analytics.dataset_build
      WHERE tenant_id = $1::uuid AND spec_id = $2::uuid
      ORDER BY built_at DESC`,
    [tenant_id, spec_id],
  );
}

/** Read a single build by id (the full reproducibility record). */
export async function getDatasetBuild(tenant_id: string, build_id: string): Promise<DatasetBuildRecord | null> {
  return dataService.one<DatasetBuildRecord>(
    `SELECT build_id::text, spec_id::text, tenant_id::text, window_from, window_to,
            row_count, labeled_count, lineage_ref, export_ref, built_at
       FROM analytics.dataset_build
      WHERE tenant_id = $1::uuid AND build_id = $2::uuid`,
    [tenant_id, build_id],
  );
}
