/**
 * P10/E1 — server-side obligation enforcement helper.
 *
 * Pure and dependency-free so the api-gateway and any data-reading SDK can call
 * it on a result set BEFORE serialization. This is the enforcement point that
 * makes obligations real: `mask_fields` are redacted and `row_filter` rows are
 * dropped even when a caller forgets to apply them (closes the field-leak risk,
 * critique Scenario 7 / OC-11).
 *
 * Source: Architecture v3.2 §11A.3, P16. Feature "Server-side obligation
 * enforcement helper".
 */

import type { Obligations } from './p10-security';

/** Sentinel a masked field is replaced with. `null` leaks neither value nor length. */
export const REDACTED: null = null;

export interface ApplyObligationsResult<T> {
  /** The enforced rows: filtered then masked (new objects when masking occurs). */
  rows: T[];
  /** The field paths that were redacted (echoes obligations.mask_fields). */
  masked_fields: string[];
  /** How many rows row_filter removed. */
  filtered_out: number;
}

/** Reads a dot-path value (`"a.b.c"`) from a plain object; undefined if absent. */
function getByPath(obj: Record<string, unknown>, path: string): unknown {
  let cur: unknown = obj;
  for (const part of path.split('.')) {
    if (cur === null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}

/**
 * Recursively clones plain objects/arrays so masking never mutates the caller's
 * data. Non-plain values (Date, class instances) are passed by reference — they
 * are only ever replaced wholesale, never mutated in place.
 */
function deepClone<T>(value: T): T {
  if (Array.isArray(value)) return value.map((v) => deepClone(v)) as unknown as T;
  if (value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = deepClone(v);
    return out as T;
  }
  return value;
}

/** Redacts a single dot-path in place. Returns true if the leaf existed. */
function redactByPath(obj: Record<string, unknown>, path: string): boolean {
  const parts = path.split('.');
  let cur: Record<string, unknown> = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const next = cur[parts[i]];
    if (next === null || typeof next !== 'object' || Array.isArray(next)) return false;
    cur = next as Record<string, unknown>;
  }
  const leaf = parts[parts.length - 1];
  if (Object.prototype.hasOwnProperty.call(cur, leaf)) {
    cur[leaf] = REDACTED;
    return true;
  }
  return false;
}

/** Loose value equality used by row_filter (handles primitives, arrays, objects). */
function valuesEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null || typeof a !== typeof b) return false;
  if (typeof a === 'object') return JSON.stringify(a) === JSON.stringify(b);
  return false;
}

/**
 * True if `row` satisfies EVERY key=value equality in `filter` (AND semantics).
 * Keys are dot-paths, so `{ "patient.tenant_id": "..." }` matches nested fields.
 */
export function rowMatchesFilter(
  row: Record<string, unknown>,
  filter: Record<string, unknown>,
): boolean {
  for (const [key, expected] of Object.entries(filter)) {
    if (!valuesEqual(getByPath(row, key), expected)) return false;
  }
  return true;
}

/**
 * Returns a masked copy of one row with each `mask_fields` path redacted.
 * The input is never mutated.
 */
export function maskRow<T extends Record<string, unknown>>(row: T, maskFields: string[]): T {
  if (maskFields.length === 0) return row;
  const clone = deepClone(row);
  for (const field of maskFields) redactByPath(clone as Record<string, unknown>, field);
  return clone;
}

/**
 * Enforces obligations on a result set: drops rows failing `row_filter`, then
 * redacts `mask_fields` on the survivors. A missing/empty obligations object is
 * a no-op that returns the input rows unchanged (pre-P10 behaviour).
 */
export function applyObligations<T extends Record<string, unknown>>(
  rows: T[],
  obligations: Obligations | undefined | null,
): ApplyObligationsResult<T> {
  if (!obligations) return { rows, masked_fields: [], filtered_out: 0 };

  let working = rows;
  let filtered_out = 0;

  const filter = obligations.row_filter;
  if (filter && Object.keys(filter).length > 0) {
    const before = working.length;
    working = working.filter((row) => rowMatchesFilter(row, filter));
    filtered_out = before - working.length;
  }

  const maskFields = obligations.mask_fields ?? [];
  if (maskFields.length > 0) {
    working = working.map((row) => maskRow(row, maskFields));
  }

  return { rows: working, masked_fields: maskFields, filtered_out };
}
