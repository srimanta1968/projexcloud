/**
 * P9 / E2.F3 — bge-small-en-v1.5 embedding index.
 *
 * Per Q-1 decision: in-process embedding via @huggingface/transformers
 * (Xenova/bge-small-en-v1.5, INT8 quantized ONNX). 384-dim, ~33MB on disk,
 * deterministic per (model, dtype, input) tuple. Required for AC-12
 * (offline local-MCP reads) — no per-query API cost, no network at runtime
 * once the model is cached.
 *
 * File layout written to disk:
 *   dist/registry.embeddings.bin   — binary float32 little-endian vectors
 *   dist/registry.embeddings.meta.json — record-index → identifier mapping
 *
 * Determinism contract (AC-2):
 *   - Records ordered by key (SDK-name first, then scenario-id within SDK)
 *   - Model + dtype + dim pinned in meta; consumers must verify
 *   - Binary header is fixed-width; sidecar JSON has stable key order
 */

import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { Catalog } from './types';

export const EMBEDDING_MODEL = 'Xenova/bge-small-en-v1.5';
export const EMBEDDING_DTYPE = 'q8' as const;
export const EMBEDDING_DIM = 384;

const MAGIC = 'RGE1';
const FORMAT_VERSION = 1;
const HEADER_BYTES = 16; // magic(4) + version(4) + count(4) + dim(4)

export type EmbeddingKind = 'summary' | 'scenario';

export interface EmbeddingRecordMeta {
  index: number;
  key: string;
  sdk_name: string;
  kind: EmbeddingKind;
  scenario_id?: string;
  /** Text that was embedded; useful for debugging + offline preview. */
  source_text: string;
}

export interface EmbeddingIndex {
  model: string;
  dtype: string;
  dim: number;
  records: EmbeddingRecordMeta[];
  /** Flat Float32Array of length records.length * dim, row-major. */
  vectors: Float32Array;
}

export interface EmbedderHandle {
  /** Embed an arbitrary string into a 384-dim L2-normalized Float32Array. */
  embed(text: string): Promise<Float32Array>;
  /** Batch variant. */
  embedAll(texts: string[]): Promise<Float32Array[]>;
}

/**
 * Lazily initializes the bge-small pipeline. The @huggingface/transformers
 * import is dynamic so callers who never embed (e.g., CLI with --no-embed)
 * don't pay the loader cost.
 */
export async function createEmbedder(): Promise<EmbedderHandle> {
  const mod: typeof import('@huggingface/transformers') = await import('@huggingface/transformers');
  const pipe = await mod.pipeline('feature-extraction', EMBEDDING_MODEL, {
    dtype: EMBEDDING_DTYPE,
  });

  async function embed(text: string): Promise<Float32Array> {
    const out = await pipe(text, { pooling: 'mean', normalize: true });
    // out.data is Float32Array of length EMBEDDING_DIM
    return new Float32Array(out.data as Float32Array);
  }

  async function embedAll(texts: string[]): Promise<Float32Array[]> {
    const out: Float32Array[] = [];
    for (const t of texts) out.push(await embed(t));
    return out;
  }

  return { embed, embedAll };
}

/**
 * Produces the embedding records-to-embed list from a catalog: one per SDK
 * summary + one per scenario. Returns metadata-only (no vectors yet) so
 * the caller can decide whether to actually run the model.
 */
export function planEmbeddings(catalog: Catalog): Array<Omit<EmbeddingRecordMeta, 'index'>> {
  const planned: Array<Omit<EmbeddingRecordMeta, 'index'>> = [];
  for (const entry of catalog.entries) {
    const name = entry.manifest.name;
    planned.push({
      key: name,
      sdk_name: name,
      kind: 'summary',
      source_text: `${name}\n${entry.manifest.tags.join(' ')}\n${entry.manifest.summary}`,
    });
    for (const s of entry.manifest.scenarios) {
      planned.push({
        key: `${name}#${s.id}`,
        sdk_name: name,
        kind: 'scenario',
        scenario_id: s.id,
        source_text: `${s.title}\n${s.when_to_use}\n${s.expected_outcome}`,
      });
    }
  }
  // Deterministic order: SDK summary before its scenarios; SDKs already
  // sorted in catalog.entries; scenarios in the order the manifest
  // declares them (SDK-owner intent).
  return planned;
}

/**
 * Runs the embedder over every planned record and assembles a complete
 * EmbeddingIndex. Caller passes a pre-initialized EmbedderHandle (via
 * createEmbedder()).
 */
export async function buildEmbeddingIndex(
  catalog: Catalog,
  embedder: EmbedderHandle,
): Promise<EmbeddingIndex> {
  const planned = planEmbeddings(catalog);
  const vectors = new Float32Array(planned.length * EMBEDDING_DIM);
  const records: EmbeddingRecordMeta[] = [];

  for (let i = 0; i < planned.length; i++) {
    const p = planned[i];
    const vec = await embedder.embed(p.source_text);
    if (vec.length !== EMBEDDING_DIM) {
      throw new Error(
        `embedding dim mismatch for "${p.key}": expected ${EMBEDDING_DIM}, got ${vec.length}`,
      );
    }
    vectors.set(vec, i * EMBEDDING_DIM);
    records.push({ index: i, ...p });
  }

  return {
    model: EMBEDDING_MODEL,
    dtype: EMBEDDING_DTYPE,
    dim: EMBEDDING_DIM,
    records,
    vectors,
  };
}

/* ----------------------------------------------------------- serialization */

export interface SerializedEmbeddings {
  bin: Buffer;
  meta: string;
}

export function serializeEmbeddingIndex(idx: EmbeddingIndex): SerializedEmbeddings {
  const totalBytes = HEADER_BYTES + idx.records.length * idx.dim * 4;
  const bin = Buffer.allocUnsafe(totalBytes);
  bin.write(MAGIC, 0, 4, 'ascii');
  bin.writeUInt32LE(FORMAT_VERSION, 4);
  bin.writeUInt32LE(idx.records.length, 8);
  bin.writeUInt32LE(idx.dim, 12);
  // Pack vectors as LE float32.
  for (let i = 0; i < idx.vectors.length; i++) {
    bin.writeFloatLE(idx.vectors[i], HEADER_BYTES + i * 4);
  }

  // Stable JSON for the sidecar.
  const metaObj = {
    catalog_version: '1.0',
    model: idx.model,
    dtype: idx.dtype,
    dim: idx.dim,
    record_count: idx.records.length,
    records: idx.records.map((r) => ({
      index: r.index,
      key: r.key,
      sdk_name: r.sdk_name,
      kind: r.kind,
      ...(r.scenario_id !== undefined ? { scenario_id: r.scenario_id } : {}),
    })),
  };
  return { bin, meta: stableStringify(metaObj) + '\n' };
}

export function writeEmbeddingIndex(idx: EmbeddingIndex, binPath: string, metaPath: string): void {
  const s = serializeEmbeddingIndex(idx);
  writeFileSync(binPath, s.bin);
  writeFileSync(metaPath, s.meta);
}

export function loadEmbeddingIndex(binPath: string, metaPath: string): EmbeddingIndex {
  const bin = readFileSync(binPath);
  const meta = JSON.parse(readFileSync(metaPath, 'utf-8')) as {
    model: string;
    dtype: string;
    dim: number;
    record_count: number;
    records: Array<EmbeddingRecordMeta>;
  };

  // Header validation
  const magic = bin.subarray(0, 4).toString('ascii');
  if (magic !== MAGIC) throw new Error(`embedding bin magic mismatch: got "${magic}"`);
  const version = bin.readUInt32LE(4);
  if (version !== FORMAT_VERSION) throw new Error(`unsupported embedding format version ${version}`);
  const recordCount = bin.readUInt32LE(8);
  const dim = bin.readUInt32LE(12);
  if (recordCount !== meta.record_count) {
    throw new Error(`bin/meta record_count mismatch: ${recordCount} vs ${meta.record_count}`);
  }
  if (dim !== meta.dim) {
    throw new Error(`bin/meta dim mismatch: ${dim} vs ${meta.dim}`);
  }

  // Source_text isn't stored in meta to keep it compact; consumers can
  // re-derive from the catalog if needed.
  const records: EmbeddingRecordMeta[] = meta.records.map((r) => ({
    ...r,
    source_text: '',
  }));

  // Read vectors (Float32Array view backed by a copy so callers can keep
  // the Buffer GC'd).
  const vecCount = recordCount * dim;
  const vectors = new Float32Array(vecCount);
  for (let i = 0; i < vecCount; i++) {
    vectors[i] = bin.readFloatLE(HEADER_BYTES + i * 4);
  }

  return { model: meta.model, dtype: meta.dtype, dim, records, vectors };
}

/** sha256 hex of the binary blob — useful for determinism CI checks. */
export function embeddingsContentHash(idx: EmbeddingIndex): string {
  return createHash('sha256').update(serializeEmbeddingIndex(idx).bin).digest('hex');
}

/* --------------------------------------------------------------- search */

/**
 * Cosine similarity between two equal-length Float32Arrays.
 * Vectors from bge-small are already L2-normalized when produced via
 * pipeline({ normalize: true }), so cosine = dot product. We still
 * compute the full formula here so this function is correct for any
 * pair of vectors a caller might pass in.
 */
export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) throw new Error('vector dim mismatch');
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom > 0 ? dot / denom : 0;
}

export interface SearchHit {
  record: EmbeddingRecordMeta;
  score: number;
}

/**
 * Brute-force top-k cosine search. The catalog is small (~70 SDKs × ~5
 * scenarios ≈ 350 vectors at full scale); no need for HNSW/FAISS. Linear
 * scan over 350 × 384 dims is well under 1ms on any modern CPU.
 */
export function searchEmbeddings(
  idx: EmbeddingIndex,
  query: Float32Array,
  top_k: number,
): SearchHit[] {
  const hits: SearchHit[] = [];
  for (const r of idx.records) {
    const offset = r.index * idx.dim;
    const v = idx.vectors.subarray(offset, offset + idx.dim);
    hits.push({ record: r, score: cosineSimilarity(query, v) });
  }
  hits.sort((a, b) => b.score - a.score);
  return hits.slice(0, top_k);
}

/* ---------------------------------------------------------- stable JSON */

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) {
    return '[' + value.map(stableStringify).join(',') + ']';
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + stableStringify(obj[k])).join(',') + '}';
}
