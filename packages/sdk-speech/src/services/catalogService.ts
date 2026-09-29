import { dataService } from '@projexlight/db-runtime';
import { notFound, validationError } from '../models/errors';

/**
 * The voice provider catalog (VA·E4 · TK-4489): every STT, TTS, LLM-for-voice and
 * realtime provider/model with its list price and certification status.
 *
 * The catalog is global reference data (speech.catalog_entry, no tenant scoping): every
 * tenant reads the same rows. Operators change prices and certification at runtime;
 * presets and stack profiles reference entries by catalog_key (`layer:provider:model`)
 * and may only select certified ones.
 */

export const CATALOG_LAYERS = ['stt', 'tts', 'llm', 'realtime'] as const;
export type CatalogLayer = (typeof CATALOG_LAYERS)[number];

export const PRICE_UNITS = ['per_minute', 'per_1k_chars', 'per_1m_tokens'] as const;
export type PriceUnit = (typeof PRICE_UNITS)[number];

export const CERTIFICATION_STATUSES = ['certified', 'uncertified', 'revoked'] as const;
export type CertificationStatus = (typeof CERTIFICATION_STATUSES)[number];

export interface CatalogVoice {
  id: string;
  name?: string;
  language?: string;
}

export interface CatalogEntry {
  entry_id: string;
  catalog_key: string;
  layer: CatalogLayer;
  provider: string;
  model: string;
  display_name: string;
  voices: CatalogVoice[];
  languages: string[];
  list_price: number;
  unit: PriceUnit;
  /** Output-token price for per_1m_tokens entries; null otherwise. */
  output_list_price: number | null;
  currency: string;
  /** When the list price was last checked against the provider; null = seed estimate. */
  price_verified_at: string | null;
  certification_status: CertificationStatus;
  /** Convenience flag: certification_status === 'certified'. Only certified entries are selectable. */
  certified: boolean;
  certified_at: string | null;
  cert_metrics: Record<string, unknown>;
  notes: string | null;
  updated_at: string;
  updated_by: string | null;
}

interface CatalogRow extends Omit<CatalogEntry, 'list_price' | 'output_list_price' | 'certified'> {
  list_price: string;
  output_list_price: string | null;
}

const COLUMNS = `entry_id, catalog_key, layer, provider, model, display_name, voices, languages,
  list_price, unit, output_list_price, currency, price_verified_at, certification_status,
  certified_at, cert_metrics, notes, updated_at, updated_by`;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** NUMERIC comes back from pg as a string; the API speaks numbers. */
export function toEntry(row: CatalogRow): CatalogEntry {
  return {
    ...row,
    list_price: Number(row.list_price),
    output_list_price: row.output_list_price === null ? null : Number(row.output_list_price),
    certified: row.certification_status === 'certified',
  };
}

export interface CatalogFilter {
  layer?: string;
  provider?: string;
  /** 'true' = certified only, 'false' = everything not certified. */
  certified?: string;
}

/** Catalog entries, optionally narrowed by layer, provider and certification. */
export async function listCatalog(filter: CatalogFilter = {}): Promise<CatalogEntry[]> {
  const where: string[] = [];
  const params: unknown[] = [];
  if (filter.layer !== undefined) {
    if (!(CATALOG_LAYERS as readonly string[]).includes(filter.layer)) {
      throw validationError(`layer must be one of ${CATALOG_LAYERS.join(', ')}`);
    }
    params.push(filter.layer);
    where.push(`layer = $${params.length}`);
  }
  if (filter.provider !== undefined) {
    if (!/^[a-z0-9][a-z0-9_-]*$/.test(filter.provider)) throw validationError('provider must be a lowercase provider key');
    params.push(filter.provider);
    where.push(`provider = $${params.length}`);
  }
  if (filter.certified !== undefined) {
    if (filter.certified !== 'true' && filter.certified !== 'false') throw validationError('certified must be true or false');
    where.push(filter.certified === 'true' ? `certification_status = 'certified'` : `certification_status <> 'certified'`);
  }
  const rows = await dataService.rows<CatalogRow>(
    `SELECT ${COLUMNS} FROM speech.catalog_entry
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY array_position(ARRAY['stt','tts','llm','realtime'], layer), provider, model`,
    params,
  );
  return rows.map(toEntry);
}

/** One catalog entry by id. */
export async function getCatalogEntry(entryId: string): Promise<CatalogEntry> {
  if (!UUID_RE.test(entryId)) throw validationError('entry_id must be a uuid');
  const row = await dataService.one<CatalogRow>(`SELECT ${COLUMNS} FROM speech.catalog_entry WHERE entry_id = $1`, [entryId]);
  if (!row) throw notFound('catalog entry not found');
  return toEntry(row);
}

/** Entries by catalog_key (`layer:provider:model`); keys with no entry are absent from the map. */
export async function findCatalogEntries(keys: string[]): Promise<Map<string, CatalogEntry>> {
  if (keys.length === 0) return new Map();
  const rows = await dataService.rows<CatalogRow>(
    `SELECT ${COLUMNS} FROM speech.catalog_entry WHERE catalog_key = ANY($1::text[])`,
    [keys],
  );
  return new Map(rows.map((r) => [r.catalog_key, toEntry(r)]));
}
