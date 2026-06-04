import path from 'node:path';
import type { CatalogSdk } from './sdkCatalog';
import { getPackagesDir } from './sdkCatalog';
import { getCreateRequire } from './nodeRequire';
import { setLastRetrievalMode, type Retriever, type RetrievedSdk } from './retriever';

/**
 * Semantic retriever (Planner v2 — the real RAG path).
 *
 * Reuses the artifacts @projexlight/sdk-registry already builds:
 *   - registry.embeddings.bin / .meta.json — bge-small (384-dim) vectors for
 *     every SDK summary + scenario, prebuilt and checked into dist/.
 *   - the in-process bge-small embedder (Xenova/bge-small-en-v1.5, INT8 ONNX),
 *     used here only to embed the QUERY at request time.
 *
 * Why this shape:
 *   - Retrieval embeddings run on a LOCAL model — a change of the generation
 *     LLM provider never alters which SDKs are discovered.
 *   - We load the registry's CJS dist + @huggingface/transformers via a runtime
 *     `createRequire` rooted at the registry package. That (a) escapes the Next
 *     bundler's static tracing of the native ONNX module, and (b) resolves
 *     transformers from sdk-registry's own dependency context, so tenant-workspace
 *     needs no new package.json entry.
 *   - Model + index load lazily as a process singleton (first request pays ~10s
 *     cold; subsequent requests are warm). Any failure (offline, dist not built,
 *     model unavailable) flips `failed` and the caller falls back to lexical.
 *
 * This is the in-app stand-in for Epic A's pgvector-backed retriever: when the
 * catalog RAG store lands, swap the index source from the file to
 * catalog.embedding — the embed→search→map shape is identical.
 */

interface RegistryEmbeddingsModule {
  loadEmbeddingIndex(binPath: string, metaPath: string): unknown;
  searchEmbeddings(
    idx: unknown,
    query: Float32Array,
    topK: number,
  ): Array<{ record: { sdk_name: string }; score: number }>;
}

type FeaturePipeline = (
  text: string,
  opts: { pooling: 'mean'; normalize: boolean },
) => Promise<{ data: ArrayLike<number> }>;

const EMBEDDING_MODEL = 'Xenova/bge-small-en-v1.5';
const EMBEDDING_DTYPE = 'q8';

export class EmbeddingRetriever implements Retriever {
  private ready = false;
  private failed = false;
  private initPromise: Promise<void> | null = null;
  private pipe: FeaturePipeline | null = null;
  private idx: unknown = null;
  private reg: RegistryEmbeddingsModule | null = null;

  /** Defaults to <packages>/sdk-registry/dist. */
  constructor(private readonly distDir: string = path.join(getPackagesDir(), 'sdk-registry', 'dist')) {}

  /** True if the model + index loaded; false if we should fall back to lexical. */
  isAvailable(): boolean {
    return this.ready && !this.failed;
  }

  private async init(): Promise<void> {
    if (this.ready || this.failed) return;
    if (this.initPromise) return this.initPromise;
    this.initPromise = (async () => {
      try {
        const embeddingsJs = path.join(this.distDir, 'embeddings.js');
        // createRequire rooted at the registry dist: resolves both the registry
        // CJS helpers and @huggingface/transformers (a sdk-registry dependency).
        // Obtained via getCreateRequire() so Next's bundler doesn't mangle the
        // dynamic require (see nodeRequire.ts).
        const req = getCreateRequire()(embeddingsJs);
        this.reg = req('./embeddings.js') as RegistryEmbeddingsModule;
        this.idx = this.reg.loadEmbeddingIndex(
          path.join(this.distDir, 'registry.embeddings.bin'),
          path.join(this.distDir, 'registry.embeddings.meta.json'),
        );
        const tf = req('@huggingface/transformers') as {
          pipeline: (task: string, model: string, opts: { dtype: string }) => Promise<FeaturePipeline>;
        };
        const t0 = Date.now();
        this.pipe = await tf.pipeline('feature-extraction', EMBEDDING_MODEL, { dtype: EMBEDDING_DTYPE });
        console.log(`[EmbeddingRetriever] bge-small ready in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
        this.ready = true;
      } catch (err) {
        console.warn('[EmbeddingRetriever] init failed; falling back to lexical:', (err as Error).message);
        this.failed = true;
      }
    })();
    return this.initPromise;
  }

  async retrieve(intent: string, catalog: CatalogSdk[], topK: number): Promise<RetrievedSdk[]> {
    await this.init();
    if (!this.ready || !this.pipe || !this.reg) {
      throw new Error('embedding retriever unavailable');
    }

    const out = await this.pipe(intent, { pooling: 'mean', normalize: true });
    const query = new Float32Array(out.data as ArrayLike<number>);

    // Over-fetch records (summary + scenario rows per SDK), then aggregate to
    // the best score per SDK.
    const hits = this.reg.searchEmbeddings(this.idx, query, topK * 4);
    const byName = new Map(catalog.map((s) => [s.name, s]));
    const bestScore = new Map<string, number>();
    for (const h of hits) {
      const n = h.record.sdk_name;
      const prev = bestScore.get(n);
      if (prev === undefined || h.score > prev) bestScore.set(n, h.score);
    }

    const scored: RetrievedSdk[] = [];
    for (const [name, score] of Array.from(bestScore.entries())) {
      const sdk = byName.get(name);
      if (sdk) scored.push({ sdk, score });
    }
    setLastRetrievalMode('embedding');
    return scored.sort((a, b) => b.score - a.score).slice(0, topK);
  }
}
