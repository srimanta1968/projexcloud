import { createEmbedder, EMBEDDING_MODEL, EMBEDDING_DIM, type EmbedderHandle } from '@projexlight/sdk-registry';

/**
 * Shared, provider-independent embedding service (TK-3463).
 *
 * Wraps sdk-registry's in-process bge-small-en-v1.5 (INT8 ONNX) embedder as a
 * process singleton, used by both the sync job (embed cards) and any query path
 * (embed intent). Model id + dim are pinned and re-exported so the catalog
 * vector space can never silently drift — a model change is a deliberate,
 * versioned reindex, never an external-API dependency.
 */

const MODEL_TAG = 'bge-small-en-v1.5'; // short tag stored in catalog.embedding.embedding_model

let _handle: Promise<EmbedderHandle> | null = null;

/** Lazily initialize (and cache) the bge-small pipeline. */
export function getEmbedder(): Promise<EmbedderHandle> {
  const handle = _handle ?? (_handle = createEmbedder());
  return handle;
}

/** Embed a single string into a 384-dim L2-normalized Float32Array. */
export async function embed(text: string): Promise<Float32Array> {
  const h = await getEmbedder();
  return h.embed(text);
}

/** Embed many strings (sequential — the model is single-threaded ONNX). */
export async function embedAll(texts: string[]): Promise<Float32Array[]> {
  const h = await getEmbedder();
  return h.embedAll(texts);
}

export { EMBEDDING_MODEL, EMBEDDING_DIM, MODEL_TAG };
