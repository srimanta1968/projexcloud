import { dataService } from '@projexlight/db-runtime';

/**
 * ETL ingest service (TK-3468 + TK-3469).
 *
 * The batch front door external tools/agents call to import records. Lands rows
 * idempotently in ingest.record, then records provenance (sdk-lineage) and an
 * append-only audit entry (sdk-audit) via pluggable hooks — the gateway wires
 * the real implementations at boot so sdk-ingest stays free of those hard deps.
 */

export const INGEST_POOL = process.env.INGEST_POOL ?? 'default';

export type IngestMode = 'upsert' | 'insert';

export interface IngestEnvelope {
  entity: string;
  mode?: IngestMode;
  idempotency_key: string;
  records: Array<Record<string, unknown>>;
  tenant_id?: string;
}

export interface IngestResult {
  entity: string;
  imported: number;
  skipped: number;
  errors: Array<{ index: number; error: string }>;
}

/** A catalog-validated, normalized sensor reading ready for the time-series sink. */
export interface SensorReadingRow {
  sensor_id: string;
  asset_id: string;
  tenant_id: string | null;
  component_id: string | null;
  ts: string;
  value: number;
  unit: string;
  quality: string;
}

/** Provenance + audit hooks; wired by the gateway to sdk-lineage / sdk-audit. */
export interface IngestHooks {
  recordLineage?(input: { entity: string; count: number; idempotency_key: string; tenant_id?: string }): Promise<void>;
  audit?(input: { entity: string; count: number; idempotency_key: string; tenant_id?: string }): Promise<void>;
  /**
   * Time-series sink for catalog-validated sensor readings. Wired by the gateway
   * to the ClickHouse asset.sensor_reading table (Postgres mirror as fallback),
   * so sdk-ingest stays free of a hard clickhouse-runtime / sdk-asset dep.
   */
  writeSensorReadings?(rows: SensorReadingRow[]): Promise<void>;
}

let _hooks: IngestHooks = {};
export function setIngestHooks(hooks: IngestHooks): void {
  _hooks = hooks;
}

type TxQuery = (sql: string, params?: unknown[]) => Promise<{ rowCount?: number | null; rows: unknown[] }>;

/** Import a batch of records for one entity. Idempotent on (entity, idempotency_key, external_id). */
export async function ingestBatch(env: IngestEnvelope): Promise<IngestResult> {
  if (!env.entity) throw new Error('entity is required');
  if (!env.idempotency_key) throw new Error('idempotency_key is required');
  if (!Array.isArray(env.records) || env.records.length === 0) {
    throw new Error('records must be a non-empty array');
  }
  const mode: IngestMode = env.mode ?? 'upsert';
  const result: IngestResult = { entity: env.entity, imported: 0, skipped: 0, errors: [] };

  const conflict =
    mode === 'upsert'
      ? 'ON CONFLICT (entity, idempotency_key, external_id) DO UPDATE SET payload = EXCLUDED.payload, imported_at = now()'
      : 'ON CONFLICT (entity, idempotency_key, external_id) DO NOTHING';

  await dataService.tx(async (q: TxQuery) => {
    for (let i = 0; i < env.records.length; i++) {
      const rec = env.records[i];
      const externalId = (rec.external_id ?? rec.id ?? null) as string | null;
      try {
        const r = await q(
          `INSERT INTO ingest.record (tenant_id, entity, external_id, idempotency_key, payload)
           VALUES ($1,$2,$3,$4,$5) ${conflict} RETURNING id`,
          [env.tenant_id ?? null, env.entity, externalId, env.idempotency_key, JSON.stringify(rec)],
        );
        if (r.rowCount && r.rowCount > 0) result.imported++;
        else result.skipped++;
      } catch (err) {
        result.errors.push({ index: i, error: (err as Error).message });
      }
    }
  }, INGEST_POOL);

  // Best-effort provenance + audit — never block the import on these.
  try {
    await _hooks.recordLineage?.({
      entity: env.entity,
      count: result.imported,
      idempotency_key: env.idempotency_key,
      tenant_id: env.tenant_id,
    });
  } catch (err) {
    console.warn('[sdk-ingest] lineage hook failed:', (err as Error).message);
  }
  try {
    await _hooks.audit?.({
      entity: env.entity,
      count: result.imported,
      idempotency_key: env.idempotency_key,
      tenant_id: env.tenant_id,
    });
  } catch (err) {
    console.warn('[sdk-ingest] audit hook failed:', (err as Error).message);
  }

  return result;
}

/* ------------------------------------------------- typed sensor-reading ingest */

export interface SensorReadingInput {
  sensor_id: string;
  asset_id: string;
  ts?: string;
  value: number;
  unit?: string;
  quality?: string;
  component_id?: string;
}

export interface SensorBatchEnvelope {
  idempotency_key: string;
  readings: SensorReadingInput[];
  tenant_id?: string;
}

export interface SensorBatchResult {
  imported: number;
  skipped: number; // whole-batch idempotent replay
  invalid: number; // readings rejected by structural/catalog validation
  errors: Array<{ index: number; error: string }>;
}

const SENSOR_BATCH_ENTITY = 'sensor_reading.batch';

/**
 * Typed, idempotent batch ingest of sensor readings (P12 · E1). Reuses the
 * sdk-ingest idempotent envelope (a per-batch marker row in ingest.record keyed
 * by idempotency_key), validates each reading against the asset.sensor catalog,
 * then writes the catalog-valid rows to the time-series sink (ClickHouse via the
 * gateway-wired hook). Lineage + audit fire best-effort, same as ingestBatch.
 *
 * Idempotency contract: a replay with an already-processed idempotency_key is a
 * no-op (all readings reported as skipped). If the sink write fails after the
 * marker is claimed, the marker is released so a retry reprocesses the batch.
 */
export async function ingestSensorReadingsBatch(env: SensorBatchEnvelope): Promise<SensorBatchResult> {
  if (!env.idempotency_key) throw new Error('idempotency_key is required');
  if (!Array.isArray(env.readings) || env.readings.length === 0) {
    throw new Error('readings must be a non-empty array');
  }
  if (!_hooks.writeSensorReadings) {
    throw new Error('sensor-reading sink not configured');
  }

  const result: SensorBatchResult = { imported: 0, skipped: 0, invalid: 0, errors: [] };

  // 1) Structural validation.
  const structural: Array<{ idx: number; r: SensorReadingInput }> = [];
  for (let i = 0; i < env.readings.length; i++) {
    const r = env.readings[i];
    if (
      !r ||
      typeof r.sensor_id !== 'string' ||
      typeof r.asset_id !== 'string' ||
      typeof r.value !== 'number' ||
      Number.isNaN(r.value)
    ) {
      result.invalid++;
      result.errors.push({ index: i, error: 'sensor_id, asset_id and numeric value are required' });
      continue;
    }
    structural.push({ idx: i, r });
  }

  // 2) Catalog validation against asset.sensor (the catalog is the source of truth).
  let catalog = new Map<string, string>(); // sensor_id -> asset_id
  if (structural.length > 0) {
    const ids = [...new Set(structural.map((x) => x.r.sensor_id))];
    const rows = await dataService.rows<{ sensor_id: string; asset_id: string }>(
      `SELECT sensor_id::text AS sensor_id, asset_id::text AS asset_id
         FROM asset.sensor WHERE sensor_id = ANY($1::uuid[])`,
      [ids],
    );
    catalog = new Map(rows.map((x) => [x.sensor_id, x.asset_id]));
  }

  const valid: SensorReadingRow[] = [];
  for (const { idx, r } of structural) {
    const catAsset = catalog.get(r.sensor_id);
    if (!catAsset) {
      result.invalid++;
      result.errors.push({ index: idx, error: `unknown sensor_id ${r.sensor_id}` });
      continue;
    }
    if (catAsset !== r.asset_id) {
      result.invalid++;
      result.errors.push({ index: idx, error: `sensor ${r.sensor_id} does not belong to asset ${r.asset_id}` });
      continue;
    }
    valid.push({
      sensor_id: r.sensor_id,
      asset_id: r.asset_id,
      tenant_id: env.tenant_id ?? null,
      component_id: r.component_id ?? null,
      ts: r.ts ?? new Date().toISOString(),
      value: r.value,
      unit: r.unit ?? '',
      quality: r.quality ?? '',
    });
  }

  if (valid.length === 0) return result; // nothing catalog-valid to persist

  // 3) Claim the idempotency marker. A conflict means this batch already ran.
  const marker = await dataService.query(
    `INSERT INTO ingest.record (tenant_id, entity, external_id, idempotency_key, payload)
     VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (entity, idempotency_key, external_id) DO NOTHING
     RETURNING id`,
    [
      env.tenant_id ?? null,
      SENSOR_BATCH_ENTITY,
      env.idempotency_key,
      env.idempotency_key,
      JSON.stringify({ count: valid.length }),
    ],
  );
  if (!marker.rowCount) {
    return { imported: 0, skipped: env.readings.length, invalid: 0, errors: [] };
  }

  // 4) Write to the time-series sink. Release the marker on failure so a retry reprocesses.
  try {
    await _hooks.writeSensorReadings(valid);
    result.imported = valid.length;
  } catch (err) {
    try {
      await dataService.query(
        `DELETE FROM ingest.record WHERE entity = $1 AND idempotency_key = $2 AND external_id = $3`,
        [SENSOR_BATCH_ENTITY, env.idempotency_key, env.idempotency_key],
      );
    } catch (delErr) {
      console.warn('[sdk-ingest] failed to release sensor batch marker:', (delErr as Error).message);
    }
    throw err;
  }

  // 5) Best-effort provenance + audit.
  try {
    await _hooks.recordLineage?.({
      entity: SENSOR_BATCH_ENTITY,
      count: result.imported,
      idempotency_key: env.idempotency_key,
      tenant_id: env.tenant_id,
    });
  } catch (err) {
    console.warn('[sdk-ingest] lineage hook failed:', (err as Error).message);
  }
  try {
    await _hooks.audit?.({
      entity: SENSOR_BATCH_ENTITY,
      count: result.imported,
      idempotency_key: env.idempotency_key,
      tenant_id: env.tenant_id,
    });
  } catch (err) {
    console.warn('[sdk-ingest] audit hook failed:', (err as Error).message);
  }

  return result;
}
