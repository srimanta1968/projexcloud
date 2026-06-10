import type { CatalogSdk } from './sdkCatalog';
import { EmbeddingRetriever } from './embeddingRetriever';
import { PgVectorRetriever } from './pgvectorRetriever';

/**
 * Retrieval stage of Planner v2 (TK-3470).
 *
 * The planner no longer pastes the whole ~90-SDK catalog into one LLM prompt.
 * It first RETRIEVES a small candidate set, then composes from candidates only.
 * Retrieval is a stable interface so the backend can change without touching
 * the planner:
 *
 *   - LexicalRetriever (this file, default) — token-overlap scoring over
 *     summary/tags/capabilities. Zero new dependencies; runs anywhere the Next
 *     app runs; provider-independent.
 *
 *   - PgVectorRetriever (Phase A / Epic A, future) — embeds the intent with the
 *     local bge-small model and runs an HNSW cosine query over catalog.embedding
 *     in Postgres. Swaps in behind this same interface (set BUILD_RETRIEVER=pgvector)
 *     once the catalog RAG store lands; nothing else in the planner changes.
 *
 * Because retrieval embeddings (when enabled) stay on a local model, a change of
 * the *generation* LLM provider never alters which SDKs are discovered.
 */

export interface RetrievedSdk {
  sdk: CatalogSdk;
  /** 0..1 relevance score. */
  score: number;
}

export interface Retriever {
  retrieve(intent: string, catalog: CatalogSdk[], topK: number): Promise<RetrievedSdk[]>;
}

/**
 * The retrieval backend that actually produced the last result. Each leaf
 * retriever stamps this just before returning, so the API can report the
 * backend that REALLY ran rather than the configured BUILD_RETRIEVER (which lied
 * whenever embedding init failed and the chain fell back to lexical).
 */
let _lastRetrievalMode = 'none';

export function setLastRetrievalMode(mode: string): void {
  _lastRetrievalMode = mode;
}

export function getLastRetrievalMode(): string {
  return _lastRetrievalMode;
}

const STOPWORDS = new Set([
  'a', 'an', 'the', 'and', 'or', 'to', 'of', 'for', 'in', 'on', 'with', 'i',
  'we', 'want', 'need', 'build', 'building', 'app', 'application', 'system',
  'that', 'this', 'my', 'our', 'their', 'can', 'will', 'use', 'using', 'it',
]);

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 2 && !STOPWORDS.has(w));
}

/**
 * Token-overlap retriever. Scores each SDK by how many distinct intent tokens
 * appear across its tags (weighted highest), summary, and capabilities. Tags
 * are weighted because they are curated discovery keywords; the summary is
 * weighted next; capabilities (endpoint paths, hook names) catch literal
 * domain terms ("invoice", "consent").
 */
export class LexicalRetriever implements Retriever {
  async retrieve(intent: string, catalog: CatalogSdk[], topK: number): Promise<RetrievedSdk[]> {
    setLastRetrievalMode('lexical');
    const queryTokens = Array.from(new Set(tokenize(intent)));
    if (queryTokens.length === 0) {
      // No usable signal — return the highest-level SDKs so compose still has
      // material; foundation injection will add the auth baseline regardless.
      return catalog.slice(0, topK).map((sdk) => ({ sdk, score: 0 }));
    }

    const scored: RetrievedSdk[] = catalog.map((sdk) => {
      const tagText = sdk.tags.join(' ').toLowerCase();
      const summaryText = sdk.summary.toLowerCase();
      const capText = sdk.capabilities.join(' ').toLowerCase();

      let raw = 0;
      for (const t of queryTokens) {
        if (tagText.includes(t)) raw += 3;
        else if (summaryText.includes(t)) raw += 2;
        else if (capText.includes(t)) raw += 1;
      }
      // Normalize by the best achievable (all tokens hit a tag).
      const score = raw / (queryTokens.length * 3);
      return { sdk, score };
    });

    return scored
      .filter((h) => h.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, topK);
  }
}

/**
 * Tries a primary retriever and falls back to a secondary if the primary throws
 * (e.g. the embedding model is unavailable offline). Keeps the live planner
 * resilient: semantic when possible, lexical always.
 */
export class FallbackRetriever implements Retriever {
  constructor(private readonly primary: Retriever, private readonly secondary: Retriever) {}

  async retrieve(intent: string, catalog: CatalogSdk[], topK: number): Promise<RetrievedSdk[]> {
    try {
      return await this.primary.retrieve(intent, catalog, topK);
    } catch (err) {
      console.warn('[retriever] primary failed, using fallback:', (err as Error).message);
      return this.secondary.retrieve(intent, catalog, topK);
    }
  }
}

let _retriever: Retriever | null = null;

/**
 * Factory. Default: semantic (bge-small) retrieval with automatic lexical
 * fallback. Force a backend with BUILD_RETRIEVER=lexical | embedding | pgvector.
 *
 *   lexical   — token overlap, zero deps.
 *   embedding — bge-small over the sdk-registry file index (default).
 *   pgvector  — Epic A catalog.embedding store (multi-instance source of truth);
 *               chains pgvector → embedding → lexical so it degrades gracefully
 *               until the store is built + reachable.
 */
export function getRetriever(): Retriever {
  if (_retriever) return _retriever;
  const mode = (process.env.BUILD_RETRIEVER ?? 'embedding').toLowerCase();
  const lexical = new LexicalRetriever();

  if (mode === 'lexical') {
    _retriever = lexical;
    return _retriever;
  }

  // The embedding/pgvector modules defer their heavy work (model load, db
  // connect) to request time, so constructing them is cheap; the
  // FallbackRetriever drops down the chain when a backend is unavailable.
  const embedding = new FallbackRetriever(new EmbeddingRetriever(), lexical);

  if (mode === 'pgvector') {
    _retriever = new FallbackRetriever(new PgVectorRetriever(), embedding);
    return _retriever;
  }

  _retriever = embedding;
  return _retriever;
}

/** Test/override hook. */
export function setRetriever(r: Retriever): void {
  _retriever = r;
}
