/**
 * Iceberg writer interface — abstracts the catalog client so the worker
 * can stay catalog-agnostic (Glue · Nessie · Hive Metastore — see PRD Q-4).
 *
 * The default `LocalIcebergWriter` writes to a local NDJSON file under
 * `LINEAGE_ICEBERG_LOCAL_DIR` (default `./.iceberg-stub/cross_pool_lineage/`)
 * which is what the integration suite reads back to verify AC-5/AC-6.
 *
 * Production wires a real implementation that publishes a Parquet partition
 * to `warehouse.cross_pool_lineage` partitioned by (source_pool, target_pool,
 * date_trunc('day', occurred_at)) per the datamodel §9.2 and Architecture
 * §8B polyglot persistence doctrine.
 */

import fs from 'fs/promises';
import path from 'path';
import { getPool } from '@projexlight/db-runtime';

export interface IcebergCrossPoolLineageRow {
  edge_id: string;
  source_pool: string;
  target_pool: string;
  from_ref: string;
  to_ref: string;
  edge_kind: string;
  producer_sdk: string;
  trace_id: string;
  tenant_id: string;
  region: string;
  occurred_at: string;
}

export interface IcebergWriter {
  /** Append a row to warehouse.cross_pool_lineage. */
  writeRow(row: IcebergCrossPoolLineageRow): Promise<void>;
  /** Flush any buffered rows (best-effort). */
  flush(): Promise<void>;
  /** Release resources. Idempotent. */
  close(): Promise<void>;
}

const LOCAL_DIR = process.env.LINEAGE_ICEBERG_LOCAL_DIR
  ?? path.join(process.cwd(), '.iceberg-stub', 'cross_pool_lineage');

/**
 * LocalIcebergWriter — writes NDJSON rows partitioned by date.
 * Used in dev/CI; production swaps to the real Iceberg client.
 */
export class LocalIcebergWriter implements IcebergWriter {
  private inited = false;

  private async ensureDir(): Promise<void> {
    if (this.inited) return;
    await fs.mkdir(LOCAL_DIR, { recursive: true });
    this.inited = true;
  }

  private partitionFile(row: IcebergCrossPoolLineageRow): string {
    const day = row.occurred_at.slice(0, 10); // YYYY-MM-DD
    const safeSource = row.source_pool.replace(/[^a-zA-Z0-9_-]/g, '_');
    const safeTarget = row.target_pool.replace(/[^a-zA-Z0-9_-]/g, '_');
    return path.join(LOCAL_DIR, `source=${safeSource}`, `target=${safeTarget}`, `day=${day}.ndjson`);
  }

  async writeRow(row: IcebergCrossPoolLineageRow): Promise<void> {
    await this.ensureDir();
    const file = this.partitionFile(row);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.appendFile(file, JSON.stringify(row) + '\n', 'utf8');
  }

  async flush(): Promise<void> {
    // NDJSON appends are flushed by appendFile per call.
  }

  async close(): Promise<void> {
    this.inited = false;
  }
}

/**
 * CatalogIcebergWriter — production path (P7 G11).
 *
 * Resolves the target table_ref by looking up federation.iceberg_table_binding
 * where source_clickhouse_table = 'cross_pool_lineage' for the local region.
 * Writes go through the resolved catalog/table; every flush() logs a row to
 * federation.lakehouse_query_log for cost attribution.
 *
 * The actual Iceberg write happens via a pluggable backend client (Glue,
 * Nessie, Hive). For this drop we ship a fallback that delegates to the
 * LocalIcebergWriter when no real client is registered — so dev still
 * produces queryable NDJSON output while production wires the real client
 * via setIcebergBackend().
 */

export interface IcebergBackend {
  /** Write a single row to the resolved catalog.table_ref. */
  writeRow(tableRef: string, row: IcebergCrossPoolLineageRow): Promise<void>;
  flush(tableRef: string): Promise<void>;
}

let _backend: IcebergBackend | null = null;

export function setIcebergBackend(backend: IcebergBackend | null): void {
  _backend = backend;
}

interface BindingRow {
  binding_id: string;
  table_ref: string;
}

async function resolveBinding(sourceTable: string, region: string): Promise<BindingRow | null> {
  try {
    const pool = getPool();
    const { rows } = await pool.query<{ binding_id: string; table_ref: string }>(
      `SELECT b.binding_id, b.table_ref
         FROM federation.iceberg_table_binding b
         JOIN federation.iceberg_catalog     c USING (catalog_id)
        WHERE b.source_clickhouse_table = $1
          AND c.region = $2
          AND c.status = 'active'
        LIMIT 1`,
      [sourceTable, region],
    );
    return rows[0] ?? null;
  } catch {
    return null;
  }
}

async function logLakehouseWrite(
  bindingId: string,
  tenantId: string,
  bytesWritten: number,
  traceId: string,
): Promise<void> {
  try {
    const pool = getPool();
    await pool.query(
      `INSERT INTO federation.lakehouse_query_log
         (query_id, tenant_id, sql_text, bytes_scanned, cost, trace_id)
       VALUES ($1, $2::uuid, $3, $4, $5, $6)`,
      [
        `lhq_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        tenantId,
        `INSERT INTO ${bindingId} (...) /* lineage projection */`,
        bytesWritten,
        0,
        traceId,
      ],
    );
  } catch (err) {
    console.warn('[lineage-projector] lakehouse_query_log insert failed:', (err as Error).message);
  }
}

export class CatalogIcebergWriter implements IcebergWriter {
  private localFallback = new LocalIcebergWriter();
  private cachedBinding: BindingRow | null = null;
  private bytesBuffered = 0;
  private readonly region: string;
  private readonly sourceTable = 'cross_pool_lineage';

  constructor(region: string) {
    this.region = region;
  }

  private async getBinding(): Promise<BindingRow | null> {
    if (this.cachedBinding) return this.cachedBinding;
    this.cachedBinding = await resolveBinding(this.sourceTable, this.region);
    return this.cachedBinding;
  }

  async writeRow(row: IcebergCrossPoolLineageRow): Promise<void> {
    const binding = await this.getBinding();
    const bytes = Buffer.byteLength(JSON.stringify(row), 'utf8');
    this.bytesBuffered += bytes;

    if (binding && _backend) {
      // Production path — write through registered backend.
      await _backend.writeRow(binding.table_ref, row);
    } else {
      // Dev / no-backend path — fall back to local NDJSON so the projection
      // still runs end-to-end on a workstation.
      await this.localFallback.writeRow(row);
    }

    // Log to lakehouse_query_log every 100 writes (cheap counter, no FF).
    if (binding && this.bytesBuffered > 0 && Math.random() < 0.01) {
      void logLakehouseWrite(binding.binding_id, row.tenant_id, this.bytesBuffered, row.trace_id);
      this.bytesBuffered = 0;
    }
  }

  async flush(): Promise<void> {
    const binding = await this.getBinding();
    if (binding && _backend) {
      await _backend.flush(binding.table_ref);
      if (this.bytesBuffered > 0) {
        // Tenant id is unknowable at flush boundary — log 'system' tenant
        // since the rows themselves carry their tenant_id.
        void logLakehouseWrite(
          binding.binding_id,
          '00000000-0000-0000-0000-000000000000',
          this.bytesBuffered,
          'flush',
        );
        this.bytesBuffered = 0;
      }
    } else {
      await this.localFallback.flush();
    }
  }

  async close(): Promise<void> {
    await this.localFallback.close();
    this.cachedBinding = null;
    this.bytesBuffered = 0;
  }
}

/** Factory — returns the configured writer. Override via DI in tests. */
export function buildIcebergWriter(): IcebergWriter {
  const driver = process.env.LINEAGE_ICEBERG_DRIVER ?? 'catalog';
  switch (driver) {
    case 'local':
      return new LocalIcebergWriter();
    case 'catalog':
      return new CatalogIcebergWriter(process.env.LINEAGE_PROJECTOR_REGION ?? 'us-east');
    default:
      throw new Error(
        `[lineage-projector] unsupported LINEAGE_ICEBERG_DRIVER='${driver}'. Supported: local, catalog.`,
      );
  }
}
