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

/** Provenance + audit hooks; wired by the gateway to sdk-lineage / sdk-audit. */
export interface IngestHooks {
  recordLineage?(input: { entity: string; count: number; idempotency_key: string; tenant_id?: string }): Promise<void>;
  audit?(input: { entity: string; count: number; idempotency_key: string; tenant_id?: string }): Promise<void>;
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
