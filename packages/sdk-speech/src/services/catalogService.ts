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

/** The catalog_key for a layer/provider/model triple (mirrors the generated column). */
export function catalogKey(layer: CatalogLayer, provider: string, model: string): string {
  return `${layer}:${provider}:${model}`;
}

/** What an operator may change on an entry (TK-4490). Omitted fields are left as they are. */
export interface CatalogEntryPatch {
  display_name?: string;
  list_price?: number;
  output_list_price?: number | null;
  /** true stamps price_verified_at = now(); false clears it. */
  price_verified?: boolean;
  certification_status?: CertificationStatus;
  cert_metrics?: Record<string, unknown>;
  voices?: CatalogVoice[];
  languages?: string[];
  notes?: string | null;
}

const PATCH_FIELDS = new Set([
  'display_name', 'list_price', 'output_list_price', 'price_verified', 'certification_status',
  'cert_metrics', 'voices', 'languages', 'notes',
]);

const isPrice = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v < 1e8;
const isPlainObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Postgres check_violation. */
const PG_CHECK_VIOLATION = '23514';

export interface CatalogEntryChange {
  entry: CatalogEntry;
  /** Field -> { from, to } for every field the patch actually changed. */
  changes: Record<string, { from: unknown; to: unknown }>;
}

/**
 * Applies an operator edit to a catalog entry: price, certification and descriptive
 * fields change at runtime, no deploy. Certifying stamps certified_at; any other status
 * clears it, so a revoked entry immediately stops being selectable in a stack profile.
 * The caller (an admin-guarded route) audits the returned changes.
 */
export async function updateCatalogEntry(entryId: string, patch: unknown, actor: string): Promise<CatalogEntryChange> {
  if (!isPlainObject(patch)) throw validationError('body must be an object');
  const unknown = Object.keys(patch).filter((k) => !PATCH_FIELDS.has(k));
  if (unknown.length > 0) throw validationError(`unknown or read-only fields: ${unknown.join(', ')}`);
  if (Object.keys(patch).length === 0) throw validationError('nothing to update');
  const p = patch as CatalogEntryPatch;

  const sets: string[] = [];
  const params: unknown[] = [];
  const set = (col: string, value: unknown, cast = ''): void => {
    params.push(value);
    sets.push(`${col} = $${params.length + 1}${cast}`);
  };
  if (p.display_name !== undefined) {
    if (typeof p.display_name !== 'string' || p.display_name.trim().length === 0 || p.display_name.length > 200) {
      throw validationError('display_name must be a non-empty string of at most 200 characters');
    }
    set('display_name', p.display_name.trim());
  }
  if (p.list_price !== undefined) {
    if (!isPrice(p.list_price)) throw validationError('list_price must be a non-negative number');
    set('list_price', p.list_price);
  }
  if (p.output_list_price !== undefined) {
    if (p.output_list_price !== null && !isPrice(p.output_list_price)) throw validationError('output_list_price must be a non-negative number or null');
    set('output_list_price', p.output_list_price);
  }
  if (p.price_verified !== undefined) {
    if (typeof p.price_verified !== 'boolean') throw validationError('price_verified must be a boolean');
    sets.push(`price_verified_at = ${p.price_verified ? 'now()' : 'NULL'}`);
  }
  if (p.certification_status !== undefined) {
    if (!(CERTIFICATION_STATUSES as readonly string[]).includes(p.certification_status)) {
      throw validationError(`certification_status must be one of ${CERTIFICATION_STATUSES.join(', ')}`);
    }
    set('certification_status', p.certification_status);
    // Keep the original certified_at when re-certifying an already certified entry.
    sets.push(p.certification_status === 'certified' ? `certified_at = COALESCE(certified_at, now())` : `certified_at = NULL`);
  }
  if (p.cert_metrics !== undefined) {
    if (!isPlainObject(p.cert_metrics)) throw validationError('cert_metrics must be an object');
    set('cert_metrics', JSON.stringify(p.cert_metrics), '::jsonb');
  }
  if (p.voices !== undefined) {
    if (!Array.isArray(p.voices) || !p.voices.every((v) => isPlainObject(v) && typeof v.id === 'string' && v.id.length > 0)) {
      throw validationError('voices must be an array of { id, name?, language? }');
    }
    set('voices', JSON.stringify(p.voices), '::jsonb');
  }
  if (p.languages !== undefined) {
    if (!Array.isArray(p.languages) || !p.languages.every((l) => typeof l === 'string' && /^[a-z]{2,3}(-[A-Za-z0-9]{2,8})?$/.test(l))) {
      throw validationError('languages must be an array of language codes (e.g. en, pt-BR)');
    }
    set('languages', p.languages, '::text[]');
  }
  if (p.notes !== undefined) {
    if (p.notes !== null && (typeof p.notes !== 'string' || p.notes.length > 2000)) throw validationError('notes must be a string of at most 2000 characters or null');
    set('notes', p.notes);
  }

  const before = await getCatalogEntry(entryId);
  let row: CatalogRow | null;
  try {
    row = await dataService.one<CatalogRow>(
      `UPDATE speech.catalog_entry
          SET ${sets.join(', ')}, updated_at = now(), updated_by = $${params.length + 2}
        WHERE entry_id = $1
        RETURNING ${COLUMNS}`,
      [entryId, ...params, actor],
    );
  } catch (err) {
    if ((err as { code?: string }).code === PG_CHECK_VIOLATION) {
      throw validationError(
        (err as { constraint?: string }).constraint === 'catalog_entry_token_pricing'
          ? 'output_list_price is required for per_1m_tokens entries and must be null otherwise'
          : 'the update violates a catalog constraint',
      );
    }
    throw err;
  }
  if (!row) throw notFound('catalog entry not found');
  const after = toEntry(row);

  const changes: Record<string, { from: unknown; to: unknown }> = {};
  for (const key of ['display_name', 'list_price', 'output_list_price', 'price_verified_at', 'certification_status', 'cert_metrics', 'voices', 'languages', 'notes'] as const) {
    if (JSON.stringify(before[key]) !== JSON.stringify(after[key])) changes[key] = { from: before[key], to: after[key] };
  }
  return { entry: after, changes };
}
