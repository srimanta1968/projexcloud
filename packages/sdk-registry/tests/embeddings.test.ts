import { describe, expect, it } from 'vitest';
import {
  EMBEDDING_DIM,
  EMBEDDING_MODEL,
  EmbeddingIndex,
  buildEmbeddingIndex,
  cosineSimilarity,
  embeddingsContentHash,
  loadEmbeddingIndex,
  planEmbeddings,
  searchEmbeddings,
  serializeEmbeddingIndex,
  writeEmbeddingIndex,
  type EmbedderHandle,
} from '../src/embeddings';
import { buildCatalog } from '../src/catalog';
import { scanResultOK } from './fixtures';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/* ------------------------------------------------------------------ utilities */

function randomUnitVec(dim = EMBEDDING_DIM, seed = 1): Float32Array {
  // Deterministic pseudo-random LCG for stable tests.
  let s = seed;
  const v = new Float32Array(dim);
  for (let i = 0; i < dim; i++) {
    s = (s * 1664525 + 1013904223) >>> 0;
    v[i] = ((s & 0xffff) / 0xffff) * 2 - 1;
  }
  // L2 normalize.
  let n = 0;
  for (let i = 0; i < dim; i++) n += v[i] * v[i];
  n = Math.sqrt(n);
  for (let i = 0; i < dim; i++) v[i] /= n;
  return v;
}

/** Synthetic embedder that returns deterministic vectors keyed off the text content. */
function makeFakeEmbedder(): EmbedderHandle {
  const seedFor = (s: string) => Array.from(s).reduce((acc, c) => (acc * 31 + c.charCodeAt(0)) >>> 0, 17);
  return {
    embed: async (text: string) => randomUnitVec(EMBEDDING_DIM, seedFor(text) || 1),
    embedAll: async (texts: string[]) => Promise.all(texts.map((t) => randomUnitVec(EMBEDDING_DIM, seedFor(t) || 1))),
  };
}

/* --------------------------------------------------------------- cosine */

describe('cosineSimilarity', () => {
  it('returns 1 for identical L2-normalized vectors', () => {
    const v = randomUnitVec();
    expect(cosineSimilarity(v, v)).toBeCloseTo(1, 5);
  });

  it('returns -1 for opposite L2-normalized vectors', () => {
    const v = randomUnitVec();
    const neg = new Float32Array(v.map((x) => -x));
    expect(cosineSimilarity(v, neg)).toBeCloseTo(-1, 5);
  });

  it('returns 0 for orthogonal vectors', () => {
    const a = new Float32Array(EMBEDDING_DIM);
    const b = new Float32Array(EMBEDDING_DIM);
    a[0] = 1;
    b[1] = 1;
    expect(cosineSimilarity(a, b)).toBeCloseTo(0, 5);
  });

  it('throws on dim mismatch', () => {
    expect(() => cosineSimilarity(new Float32Array(3), new Float32Array(4))).toThrow();
  });
});

/* ------------------------------------------------------- planEmbeddings */

describe('planEmbeddings', () => {
  it('emits 1 summary + 1 per scenario per SDK in deterministic order', () => {
    const cat = buildCatalog({
      scan: [scanResultOK('alpha'), scanResultOK('beta')],
      built_at: '2026-05-25T00:00:00.000Z',
    });
    const planned = planEmbeddings(cat);
    expect(planned.length).toBe(2 + 3 * 2); // 2 summaries + 3 scenarios each
    // Order: alpha-summary, alpha-s1, alpha-s2, alpha-s3, beta-summary, ...
    expect(planned[0]).toMatchObject({ sdk_name: '@projexlight/sdk-alpha', kind: 'summary' });
    expect(planned[1]).toMatchObject({ sdk_name: '@projexlight/sdk-alpha', kind: 'scenario', scenario_id: 's1' });
    expect(planned[4]).toMatchObject({ sdk_name: '@projexlight/sdk-beta', kind: 'summary' });
  });
});

/* ------------------------------------------- buildEmbeddingIndex (with fake) */

describe('buildEmbeddingIndex (fake embedder)', () => {
  it('produces one vector per planned record', async () => {
    const cat = buildCatalog({
      scan: [scanResultOK('alpha')],
      built_at: '2026-05-25T00:00:00.000Z',
    });
    const idx = await buildEmbeddingIndex(cat, makeFakeEmbedder());
    expect(idx.records.length).toBe(4); // 1 summary + 3 scenarios
    expect(idx.vectors.length).toBe(4 * EMBEDDING_DIM);
    expect(idx.dim).toBe(EMBEDDING_DIM);
    expect(idx.model).toBe(EMBEDDING_MODEL);
  });

  it('is deterministic for identical inputs', async () => {
    const cat = buildCatalog({
      scan: [scanResultOK('alpha'), scanResultOK('beta')],
      built_at: '2026-05-25T00:00:00.000Z',
    });
    const a = await buildEmbeddingIndex(cat, makeFakeEmbedder());
    const b = await buildEmbeddingIndex(cat, makeFakeEmbedder());
    expect(embeddingsContentHash(a)).toBe(embeddingsContentHash(b));
  });
});

/* ---------------------------------------------- serialize / deserialize */

describe('serializeEmbeddingIndex roundtrip', () => {
  it('encodes then decodes to the same record-count, dim, and vector bytes', async () => {
    const cat = buildCatalog({
      scan: [scanResultOK('alpha')],
      built_at: '2026-05-25T00:00:00.000Z',
    });
    const idx = await buildEmbeddingIndex(cat, makeFakeEmbedder());

    const dir = mkdtempSync(join(tmpdir(), 'sdk-registry-test-'));
    const binPath = join(dir, 'r.bin');
    const metaPath = join(dir, 'r.meta.json');
    writeEmbeddingIndex(idx, binPath, metaPath);

    const loaded = loadEmbeddingIndex(binPath, metaPath);
    expect(loaded.dim).toBe(idx.dim);
    expect(loaded.records.length).toBe(idx.records.length);
    // Vectors close to original (float32 roundtrip is exact).
    for (let i = 0; i < idx.vectors.length; i++) {
      expect(loaded.vectors[i]).toBeCloseTo(idx.vectors[i], 6);
    }
  });

  it('emits a stable binary blob (sha256 identical for two runs)', async () => {
    const cat = buildCatalog({
      scan: [scanResultOK('alpha')],
      built_at: '2026-05-25T00:00:00.000Z',
    });
    const a = await buildEmbeddingIndex(cat, makeFakeEmbedder());
    const b = await buildEmbeddingIndex(cat, makeFakeEmbedder());
    expect(serializeEmbeddingIndex(a).bin.equals(serializeEmbeddingIndex(b).bin)).toBe(true);
  });

  it('rejects a bin with wrong magic', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sdk-registry-test-'));
    const binPath = join(dir, 'bad.bin');
    const metaPath = join(dir, 'bad.meta.json');
    // Write a 16-byte header with wrong magic.
    const bin = Buffer.alloc(16);
    bin.write('XXXX', 0, 4, 'ascii');
    bin.writeUInt32LE(1, 4);
    bin.writeUInt32LE(0, 8);
    bin.writeUInt32LE(EMBEDDING_DIM, 12);
    require('node:fs').writeFileSync(binPath, bin);
    require('node:fs').writeFileSync(
      metaPath,
      JSON.stringify({ model: 'x', dtype: 'q8', dim: EMBEDDING_DIM, record_count: 0, records: [] }),
    );
    expect(() => loadEmbeddingIndex(binPath, metaPath)).toThrow(/magic/);
  });
});

/* ------------------------------------------------ searchEmbeddings (brute) */

describe('searchEmbeddings', () => {
  function makeIdx(): EmbeddingIndex {
    const vectors = new Float32Array(3 * EMBEDDING_DIM);
    vectors.set(randomUnitVec(EMBEDDING_DIM, 100), 0);
    vectors.set(randomUnitVec(EMBEDDING_DIM, 200), EMBEDDING_DIM);
    vectors.set(randomUnitVec(EMBEDDING_DIM, 300), 2 * EMBEDDING_DIM);
    return {
      model: EMBEDDING_MODEL,
      dtype: 'q8',
      dim: EMBEDDING_DIM,
      records: [
        { index: 0, key: 'a', sdk_name: '@projexlight/sdk-a', kind: 'summary', source_text: '' },
        { index: 1, key: 'b', sdk_name: '@projexlight/sdk-b', kind: 'summary', source_text: '' },
        { index: 2, key: 'c', sdk_name: '@projexlight/sdk-c', kind: 'summary', source_text: '' },
      ],
      vectors,
    };
  }

  it('returns top_k hits sorted by descending score', () => {
    const idx = makeIdx();
    // Query = exactly idx record 1; expect it to score 1 and be at top.
    const query = idx.vectors.subarray(EMBEDDING_DIM, 2 * EMBEDDING_DIM);
    const queryCopy = new Float32Array(query);
    const hits = searchEmbeddings(idx, queryCopy, 2);
    expect(hits[0].record.key).toBe('b');
    expect(hits[0].score).toBeGreaterThan(0.99);
    expect(hits[1].score).toBeLessThan(hits[0].score);
  });

  it('respects top_k bound', () => {
    const idx = makeIdx();
    expect(searchEmbeddings(idx, new Float32Array(EMBEDDING_DIM), 1).length).toBe(1);
  });
});

/* ----------------------------------- real bge-small (env-gated integration) */

const RUN_INTEGRATION = process.env.EMBED_INTEGRATION === '1';

describe.runIf(RUN_INTEGRATION)('bge-small real-model smoke test', () => {
  it('embeds a string into a 384-dim L2-normalized vector', async () => {
    const { createEmbedder } = await import('../src/embeddings');
    const embedder = await createEmbedder();
    const v = await embedder.embed('consent management for healthcare');
    expect(v.length).toBe(EMBEDDING_DIM);
    let n = 0;
    for (let i = 0; i < v.length; i++) n += v[i] * v[i];
    expect(Math.sqrt(n)).toBeCloseTo(1, 4); // normalized
  }, 60_000);

  it('ranks the consent-related SDK higher than the billing one for a consent query', async () => {
    const cat = buildCatalog({
      scan: [
        scanResultOK('consent'),
        scanResultOK('billing'),
      ],
      built_at: '2026-05-25T00:00:00.000Z',
    });
    const { createEmbedder } = await import('../src/embeddings');
    const embedder = await createEmbedder();
    const idx = await buildEmbeddingIndex(cat, embedder);
    const q = await embedder.embed('how do I record a user consent decision?');
    const hits = searchEmbeddings(idx, q, 2);
    expect(hits[0].record.sdk_name).toBe('@projexlight/sdk-consent');
  }, 120_000);
});
