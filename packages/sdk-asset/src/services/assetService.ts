import { dataService } from '@projexlight/db-runtime';

export interface SensorInput {
  kind: string;
  unit?: string;
  min_value?: number;
  max_value?: number;
  sample_rate_hz?: number;
}

export interface ComponentInput {
  kind: string;
  name?: string;
  position?: unknown;
  sensors?: SensorInput[];
  children?: ComponentInput[];
}

export interface RegisterAssetInput {
  tenant_id: string;
  bu_id?: string;
  device_uuid?: string;
  model?: string;
  display_name?: string;
  components?: ComponentInput[];
}

export interface SensorNode extends SensorInput {
  sensor_id: string;
}
export interface ComponentNode {
  component_id: string;
  kind: string;
  name: string | null;
  sensors: SensorNode[];
  children: ComponentNode[];
}
export interface TwinNode {
  asset_id: string;
  tenant_id: string;
  bu_id: string | null;
  device_uuid: string | null;
  model: string | null;
  display_name: string | null;
  status: string;
  components: ComponentNode[];
}

/**
 * Registers a robot as an asset and bulk-defines its component tree + sensors
 * in a single transaction. Returns the new asset_id.
 */
export async function registerAsset(input: RegisterAssetInput): Promise<{ asset_id: string }> {
  return dataService.tx(async (q) => {
    const insertTree = async (asset_id: string, parent_id: string | null, comps: ComponentInput[] | undefined): Promise<void> => {
      for (const c of comps ?? []) {
        const row = await q<{ component_id: string }>(
          `INSERT INTO asset.component (asset_id, parent_component_id, kind, name, position)
           VALUES ($1, $2, $3, $4, $5::jsonb)
           RETURNING component_id`,
          [asset_id, parent_id, c.kind, c.name ?? null, c.position != null ? JSON.stringify(c.position) : null],
        );
        const component_id = row.rows[0].component_id;
        for (const s of c.sensors ?? []) {
          await q(
            `INSERT INTO asset.sensor (component_id, asset_id, kind, unit, min_value, max_value, sample_rate_hz)
             VALUES ($1, $2, $3, $4, $5, $6, $7)`,
            [component_id, asset_id, s.kind, s.unit ?? null, s.min_value ?? null, s.max_value ?? null, s.sample_rate_hz ?? null],
          );
        }
        await insertTree(asset_id, component_id, c.children);
      }
    };

    const asset = await q<{ asset_id: string }>(
      `INSERT INTO asset.asset (tenant_id, bu_id, device_uuid, model, display_name)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING asset_id`,
      [input.tenant_id, input.bu_id ?? null, input.device_uuid ?? null, input.model ?? null, input.display_name ?? null],
    );
    const asset_id = asset.rows[0].asset_id;
    await insertTree(asset_id, null, input.components);
    return { asset_id };
  });
}

/** Returns the full digital twin: asset -> nested components -> sensors. */
export async function getTwin(asset_id: string): Promise<TwinNode | null> {
  const a = await dataService.one<TwinNode>(
    `SELECT asset_id::text, tenant_id::text, bu_id::text, device_uuid, model, display_name, status
       FROM asset.asset WHERE asset_id = $1::uuid`,
    [asset_id],
  );
  if (!a) return null;

  const comps = await dataService.rows<{
    component_id: string;
    parent_component_id: string | null;
    kind: string;
    name: string | null;
  }>(
    `SELECT component_id::text, parent_component_id::text, kind, name
       FROM asset.component WHERE asset_id = $1::uuid ORDER BY created_at ASC`,
    [asset_id],
  );
  const sensors = await dataService.rows<{
    sensor_id: string;
    component_id: string;
    kind: string;
    unit: string | null;
    min_value: number | null;
    max_value: number | null;
    sample_rate_hz: number | null;
  }>(
    `SELECT sensor_id::text, component_id::text, kind, unit, min_value, max_value, sample_rate_hz
       FROM asset.sensor WHERE asset_id = $1::uuid ORDER BY created_at ASC`,
    [asset_id],
  );

  const byId = new Map<string, ComponentNode>();
  for (const c of comps) byId.set(c.component_id, { component_id: c.component_id, kind: c.kind, name: c.name, sensors: [], children: [] });
  for (const s of sensors) {
    const node = byId.get(s.component_id);
    if (node) node.sensors.push({ sensor_id: s.sensor_id, kind: s.kind, unit: s.unit ?? undefined, min_value: s.min_value ?? undefined, max_value: s.max_value ?? undefined, sample_rate_hz: s.sample_rate_hz ?? undefined });
  }
  const roots: ComponentNode[] = [];
  for (const c of comps) {
    const node = byId.get(c.component_id)!;
    if (c.parent_component_id && byId.has(c.parent_component_id)) byId.get(c.parent_component_id)!.children.push(node);
    else roots.push(node);
  }
  return { ...a, components: roots };
}

/* ----------------------------------------------------------- sensor readings */

export interface ReadingInput {
  sensor_id: string;
  asset_id: string;
  tenant_id: string;
  ts?: string;
  value?: number;
  quality?: string;
}

/** Idempotent-friendly batch ingest of sensor readings. Returns the count. */
export async function ingestReadings(readings: ReadingInput[]): Promise<{ ingested: number }> {
  if (!readings.length) return { ingested: 0 };
  return dataService.tx(async (q) => {
    let n = 0;
    for (const r of readings) {
      await q(
        `INSERT INTO asset.sensor_reading (sensor_id, asset_id, tenant_id, ts, value, quality)
         VALUES ($1, $2, $3, COALESCE($4::timestamptz, now()), $5, $6)`,
        [r.sensor_id, r.asset_id, r.tenant_id, r.ts ?? null, r.value ?? null, r.quality ?? null],
      );
      n += 1;
    }
    return { ingested: n };
  });
}

export interface QueryReadingsOpts {
  sensor_id?: string;
  from?: string;
  to?: string;
  /** Rollup interval: 'second' | 'minute' | 'hour' | 'day'. Omit for raw rows. */
  bucket?: string;
}

const BUCKETS = new Set(['second', 'minute', 'hour', 'day']);

/** Queries raw or rolled-up readings for an asset. Rollup aggregates per bucket. */
export async function queryReadings(asset_id: string, opts: QueryReadingsOpts): Promise<Record<string, unknown>[]> {
  const params: unknown[] = [asset_id];
  let where = 'asset_id = $1::uuid';
  if (opts.sensor_id) { params.push(opts.sensor_id); where += ` AND sensor_id = $${params.length}::uuid`; }
  if (opts.from) { params.push(opts.from); where += ` AND ts >= $${params.length}::timestamptz`; }
  if (opts.to) { params.push(opts.to); where += ` AND ts <= $${params.length}::timestamptz`; }

  if (opts.bucket && BUCKETS.has(opts.bucket)) {
    params.push(opts.bucket);
    return dataService.rows<Record<string, unknown>>(
      `SELECT sensor_id::text AS sensor_id,
              date_trunc($${params.length}, ts) AS bucket,
              count(*) AS n, min(value) AS min, max(value) AS max,
              avg(value) AS avg, (array_agg(value ORDER BY ts DESC))[1] AS last
         FROM asset.sensor_reading
        WHERE ${where}
        GROUP BY sensor_id, bucket
        ORDER BY bucket DESC
        LIMIT 5000`,
      params,
    );
  }
  return dataService.rows<Record<string, unknown>>(
    `SELECT sensor_id::text AS sensor_id, ts, value, quality
       FROM asset.sensor_reading WHERE ${where} ORDER BY ts DESC LIMIT 5000`,
    params,
  );
}
