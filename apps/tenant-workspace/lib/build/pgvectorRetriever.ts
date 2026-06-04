import path from 'node:path';
import type { CatalogSdk } from './sdkCatalog';
import { getPackagesDir } from './sdkCatalog';
import { getCreateRequire } from './nodeRequire';
import { setLastRetrievalMode, type Retriever, type RetrievedSdk } from './retriever';

/**
 * Production retriever backed by the Epic A pgvector catalog store
 * (`@projexlight/sdk-catalog-index`). Opt-in via BUILD_RETRIEVER=pgvector.
 *
 * Embeds the intent with the shared bge-small model and runs an HNSW cosine
 * query over `catalog.embedding` in the global-catalog pool — the multi-instance,
 * always-fresh source of truth (vs. the per-process file index the embedding
 * retriever loads). The embed→search→map contract is identical to
 * EmbeddingRetriever; only the index source differs.
 *
 * Requirements (hence the fallback chain in getRetriever): `sdk-catalog-index`
 * must be built (dist present) AND the global-catalog pool must be reachable +
 * synced. When either is missing, `retrieve` throws and the FallbackRetriever
 * drops to the embedding/lexical path. We load the package via `createRequire`
 * rooted at the monorepo packages dir so tenant-workspace needs no hard
 * dependency and the default build never pulls in pg/db-runtime.
 */

interface CatalogIndexModule {
  embed(text: string): Promise<Float32Array>;
  searchCatalog(
    vec: Float32Array | number[],
    topK: number,
    opts?: { kind?: string },
  ): Promise<Array<{ sdk_name: string; score: number }>>;
}

export class PgVectorRetriever implements Retriever {
  private mod: CatalogIndexModule | null = null;
  private failed = false;

  private load(): CatalogIndexModule {
    if (this.mod) return this.mod;
    const distEntry = path.join(getPackagesDir(), 'sdk-catalog-index', 'dist', 'index.js');
    // createRequire rooted at the package so its own node_modules / workspace
    // deps (db-runtime, pg) resolve. Obtained via getCreateRequire() so Next's
    // bundler doesn't mangle the dynamic require (see nodeRequire.ts).
    const req = getCreateRequire()(distEntry);
    this.mod = req(distEntry) as CatalogIndexModule;
    return this.mod;
  }

  async retrieve(intent: string, catalog: CatalogSdk[], topK: number): Promise<RetrievedSdk[]> {
    if (this.failed) throw new Error('pgvector retriever unavailable');
    let mod: CatalogIndexModule;
    try {
      mod = this.load();
    } catch (err) {
      this.failed = true;
      throw new Error('sdk-catalog-index not built/reachable: ' + (err as Error).message);
    }

    const queryVec = await mod.embed(intent);
    const hits = await mod.searchCatalog(queryVec, topK);

    const byName = new Map(catalog.map((s) => [s.name, s]));
    const out: RetrievedSdk[] = [];
    for (const h of hits) {
      const sdk = byName.get(h.sdk_name);
      if (sdk) out.push({ sdk, score: h.score });
    }
    setLastRetrievalMode('pgvector');
    return out.sort((a, b) => b.score - a.score).slice(0, topK);
  }
}
