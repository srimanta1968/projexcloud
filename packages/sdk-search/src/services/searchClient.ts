import type { SearchDsl, SearchHit } from '../models/search.model';

/**
 * SearchClient contract — abstracts the real OpenSearch client behind a
 * minimal interface. Production swaps the synthetic in-process implementation
 * for @opensearch-project/opensearch via registerSearchClient().
 *
 * FR-SRC-2: per-tenant index name resolution lives in this layer so the
 * service code can stay client-agnostic.
 */

export interface IndexedDoc {
  _id: string;
  _source: Record<string, unknown>;
}

export interface SearchClient {
  ensureIndex(index_name: string, mappings: Record<string, unknown>): Promise<void>;
  index(index_name: string, doc_id: string, source: Record<string, unknown>): Promise<void>;
  delete(index_name: string, doc_id: string): Promise<void>;
  search(index_name: string, dsl: SearchDsl): Promise<{ hits: SearchHit[]; total: number; took_ms: number }>;
  deleteIndex(index_name: string): Promise<void>;
}

/* ---------------------------------------------------- Synthetic in-memory */

/**
 * SyntheticSearchClient — in-process Map<index, Map<doc_id, source>> with
 * a tiny query evaluator covering the subset of DSL we ship: `bool.filter`
 * with `terms` for ABAC scope match, `multi_match` for free-text, and
 * `term` for exact-match facets. Enough for dev / test parity.
 *
 * Production deploys call registerSearchClient(new OpenSearchClient(...)).
 */
class SyntheticSearchClient implements SearchClient {
  private readonly indexes = new Map<string, Map<string, Record<string, unknown>>>();

  async ensureIndex(index_name: string, _mappings: Record<string, unknown>): Promise<void> {
    if (!this.indexes.has(index_name)) this.indexes.set(index_name, new Map());
  }

  async index(index_name: string, doc_id: string, source: Record<string, unknown>): Promise<void> {
    await this.ensureIndex(index_name, {});
    this.indexes.get(index_name)!.set(doc_id, source);
  }

  async delete(index_name: string, doc_id: string): Promise<void> {
    this.indexes.get(index_name)?.delete(doc_id);
  }

  async deleteIndex(index_name: string): Promise<void> {
    this.indexes.delete(index_name);
  }

  async search(
    index_name: string,
    dsl: SearchDsl,
  ): Promise<{ hits: SearchHit[]; total: number; took_ms: number }> {
    const started = Date.now();
    const idx = this.indexes.get(index_name);
    if (!idx) return { hits: [], total: 0, took_ms: Date.now() - started };

    const matches: SearchHit[] = [];
    for (const [doc_id, source] of idx.entries()) {
      const { ok, score } = evaluate(source, dsl);
      if (ok) matches.push({ _id: doc_id, _score: score, _source: source });
    }
    matches.sort((a, b) => b._score - a._score);

    const from = dsl.from ?? 0;
    const size = dsl.size ?? 20;
    return {
      hits: matches.slice(from, from + size),
      total: matches.length,
      took_ms: Date.now() - started,
    };
  }
}

/* ----------------------------------------- Minimal DSL evaluator (test-grade) */

function evaluate(source: Record<string, unknown>, dsl: SearchDsl): { ok: boolean; score: number } {
  if (!dsl.query) return { ok: true, score: 1 };
  let score = 1;
  const q = dsl.query;

  if (q.bool) {
    if (q.bool.filter) {
      for (const f of q.bool.filter) {
        if (!matchClause(source, f)) return { ok: false, score: 0 };
      }
    }
    if (q.bool.must) {
      for (const m of q.bool.must) {
        if (!matchClause(source, m)) return { ok: false, score: 0 };
        score += 1;
      }
    }
    if (q.bool.must_not) {
      for (const n of q.bool.must_not) {
        if (matchClause(source, n)) return { ok: false, score: 0 };
      }
    }
    if (q.bool.should) {
      const anyHit = q.bool.should.some((s) => matchClause(source, s));
      if (anyHit) score += 0.5;
    }
    return { ok: true, score };
  }

  if (q.term) {
    return matchClause(source, { term: q.term })
      ? { ok: true, score: 2 }
      : { ok: false, score: 0 };
  }

  if (q.match) {
    return matchClause(source, { match: q.match })
      ? { ok: true, score: 1.5 }
      : { ok: false, score: 0 };
  }

  if (q.multi_match) {
    return matchClause(source, { multi_match: q.multi_match })
      ? { ok: true, score: 1.5 }
      : { ok: false, score: 0 };
  }

  return { ok: true, score };
}

function matchClause(source: Record<string, unknown>, clause: unknown): boolean {
  if (!clause || typeof clause !== 'object') return false;
  const c = clause as Record<string, unknown>;

  if (c.term && typeof c.term === 'object') {
    for (const [field, val] of Object.entries(c.term as Record<string, unknown>)) {
      if (source[field] !== val) return false;
    }
    return true;
  }
  if (c.terms && typeof c.terms === 'object') {
    for (const [field, vals] of Object.entries(c.terms as Record<string, unknown>)) {
      const list = Array.isArray(vals) ? vals : [vals];
      const v = source[field];
      if (Array.isArray(v)) {
        if (!v.some((x) => list.includes(x))) return false;
      } else if (!list.includes(v)) return false;
    }
    return true;
  }
  if (c.match && typeof c.match === 'object') {
    for (const [field, val] of Object.entries(c.match as Record<string, unknown>)) {
      const v = source[field];
      if (typeof v !== 'string' || typeof val !== 'string') return false;
      if (!v.toLowerCase().includes(val.toLowerCase())) return false;
    }
    return true;
  }
  if (c.multi_match && typeof c.multi_match === 'object') {
    const mm = c.multi_match as { query: unknown; fields: unknown };
    if (typeof mm.query !== 'string' || !Array.isArray(mm.fields)) return false;
    const needle = mm.query.toLowerCase();
    return (mm.fields as string[]).some((field) => {
      const v = source[field];
      return typeof v === 'string' && v.toLowerCase().includes(needle);
    });
  }
  if (c.exists && typeof c.exists === 'object') {
    const field = (c.exists as { field: string }).field;
    return source[field] !== undefined && source[field] !== null;
  }
  return false;
}

/* ---------------------------------------- Pluggable client registration */

const SYNTHETIC_ALLOWED = (): boolean => {
  if (process.env.NODE_ENV !== 'production') return true;
  return process.env.ALLOW_SYNTHETIC_SEARCH_CLIENT === 'true';
};

/**
 * In production we refuse to use the in-memory SyntheticSearchClient because
 * (a) it loses all data on restart and (b) it is per-pod — different pods
 * return different results. Wire `registerSearchClient(new OpenSearchClient(...))`
 * at boot, or set ALLOW_SYNTHETIC_SEARCH_CLIENT=true for sandbox.
 */
class FailLoudSearchClient implements SearchClient {
  private fail(): never {
    throw new Error('sdk-search: no SearchClient registered for production — wire registerSearchClient(new OpenSearchClient(...)) before boot, or set ALLOW_SYNTHETIC_SEARCH_CLIENT=true');
  }
  async ensureIndex(): Promise<void> { this.fail(); }
  async index(): Promise<void> { this.fail(); }
  async delete(): Promise<void> { this.fail(); }
  async deleteIndex(): Promise<void> { this.fail(); }
  async search(): Promise<{ hits: SearchHit[]; total: number; took_ms: number }> { this.fail(); }
}

let activeClient: SearchClient = SYNTHETIC_ALLOWED() ? new SyntheticSearchClient() : new FailLoudSearchClient();

export function registerSearchClient(client: SearchClient): void {
  activeClient = client;
}

export function getSearchClient(): SearchClient {
  return activeClient;
}

/**
 * What kind of client is actually wired, so a caller can tell "search is not
 * available here" from "search ran and matched nothing".
 *
 * WHY THIS IS WORTH EXPOSING. Those two are indistinguishable from the outside
 * today: an unwired deployment answers every query with a 500 that a consuming
 * app reasonably renders as an empty result set, so a screen shows "0 results"
 * for a backend that was never connected. A consumer that can read this degrades
 * honestly — "search is unavailable" — instead of quietly asserting there is
 * nothing to find.
 *
 * 'fail-loud' is the state that matters: it means production has no backend and
 * every query WILL 500.
 */
export function searchClientState(): {
  kind: 'registered' | 'synthetic' | 'fail-loud';
  available: boolean;
  reason?: string;
} {
  if (activeClient instanceof FailLoudSearchClient) {
    return {
      kind: 'fail-loud',
      available: false,
      reason:
        'no SearchClient registered for this deployment — every query will fail until '
        + 'registerSearchClient(new OpenSearchClient(...)) is wired at boot',
    };
  }
  if (activeClient instanceof SyntheticSearchClient) {
    return {
      kind: 'synthetic',
      available: true,
      reason: 'synthetic in-memory client — results are fabricated and must not be trusted in production',
    };
  }
  return { kind: 'registered', available: true };
}

/**
 * Per-pool tenant-scoped index name (FR-SRC-3).
 * Convention: ten-{pool_index}-{tenant_id}-{entity_kind}.
 * Pool index defaults to 0 if not supplied — production resolves per-tenant
 * pool via sdk-pool-router.
 */
export function resolveIndexName(
  tenant_id: string,
  entity_kind: string,
  pool_index = 0,
): string {
  return `ten-${pool_index}-${tenant_id}-${entity_kind}`.toLowerCase();
}
