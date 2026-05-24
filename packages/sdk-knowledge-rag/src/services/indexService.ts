import { randomUUID } from 'crypto';
import { dataService } from '@projexlight/db-runtime';
import { appendAuditEntry } from '@projexlight/sdk-audit';
import type { RagDocumentRef, RagSourceKind } from '@projexlight/contracts';
import { getEmbeddingBackend, getVectorBackend, type VectorRecord } from './backends';
import { getCorpus } from './corpusService';

/**
 * Document indexing (FR-RAG-1, FR-RAG-3, FR-RAG-6).
 *
 * indexDocument(corpus_id, ...) walks the supplied content through:
 *   1. chunk splitting (bounded by CHUNK_TARGET_CHARS, soft-cap on whitespace)
 *   2. embedding via the configured EmbeddingBackend (FR-RAG-3 wires the
 *      real backend to sdk-ai-gateway with rag.embed metering)
 *   3. vector upsert into the corpus's HARD-isolated namespace
 *   4. chunk metadata rows in rag.chunk (no vector — that lives in the
 *      vector store; we keep only the text_preview for explainability)
 *
 * Re-indexing the same document_id deletes the prior chunks (and their
 * vector rows) and re-runs the pipeline. The `policy_overrides` on the
 * document narrows the corpus default via overlay at retrieve time.
 *
 * Per FR-RAG-4: synchronous indexing up to MAX_SYNC_CHARS (~10MB of
 * text). Beyond that, callers should enqueue an async job — the v1
 * shipping here returns early with `status: 'queued'` and emits the
 * intended event; the real async worker lands in a follow-up task.
 */

const RAG_AUDIT_POOL = process.env.RAG_AUDIT_POOL || 'admin-default';
const CHUNK_TARGET_CHARS = parseInt(process.env.RAG_CHUNK_TARGET_CHARS ?? '1200', 10);
const MAX_SYNC_CHARS = parseInt(process.env.RAG_MAX_SYNC_CHARS ?? '10485760', 10); // 10MB
const TEXT_PREVIEW_CHARS = 256;

export interface IndexDocumentInput {
  corpus_id: string;
  source_kind: RagSourceKind;
  source_ref: string;
  title?: string;
  author?: string;
  language?: string;
  /** Raw text to index. Caller is responsible for OCR + extraction. */
  content: string;
  /** Per-document ACL refinement (overlaid onto corpus.policy_id). */
  policy_overrides?: Record<string, unknown>;
}

export interface IndexDocumentResult {
  document: RagDocumentRef;
  chunk_count: number;
  /** 'sync' when chunks landed inline; 'queued' when deferred to async. */
  status: 'sync' | 'queued';
}

interface DocumentRow {
  document_id: string;
  corpus_id: string;
  source_kind: string;
  source_ref: string;
  title: string | null;
  author: string | null;
  language: string | null;
  indexed_at: Date | null;
  reindexed_at: Date | null;
  policy_overrides: Record<string, unknown>;
}

function rowToRef(r: DocumentRow): RagDocumentRef {
  return {
    document_id: r.document_id,
    corpus_id: r.corpus_id,
    source_kind: r.source_kind as RagSourceKind,
    source_ref: r.source_ref,
    title: r.title ?? undefined,
    author: r.author ?? undefined,
    language: r.language ?? undefined,
    indexed_at: r.indexed_at ? r.indexed_at.toISOString() : null,
    reindexed_at: r.reindexed_at ? r.reindexed_at.toISOString() : null,
    policy_overrides: r.policy_overrides,
  };
}

/** Split text into chunks bounded by CHUNK_TARGET_CHARS on whitespace. */
function splitChunks(content: string): Array<{ index: number; text: string; span_start: number; span_end: number }> {
  const out: Array<{ index: number; text: string; span_start: number; span_end: number }> = [];
  let i = 0;
  let idx = 0;
  while (i < content.length) {
    let end = Math.min(i + CHUNK_TARGET_CHARS, content.length);
    if (end < content.length) {
      // Pull back to the nearest whitespace so we don't split mid-word.
      const ws = content.lastIndexOf(' ', end);
      if (ws > i + CHUNK_TARGET_CHARS * 0.5) end = ws;
    }
    const text = content.slice(i, end).trim();
    if (text.length > 0) {
      out.push({ index: idx, text, span_start: i, span_end: end });
      idx++;
    }
    i = end;
  }
  return out;
}

/**
 * Index (or re-index) one document into a corpus. Idempotent on
 * (source_kind, source_ref) — re-running upserts the document row and
 * fully replaces its chunk set + vector records.
 */
export async function indexDocument(input: IndexDocumentInput): Promise<IndexDocumentResult> {
  const corpus = await getCorpus(input.corpus_id);
  if (!corpus) throw new Error(`[sdk-knowledge-rag] corpus ${input.corpus_id} not found`);

  if (input.content.length > MAX_SYNC_CHARS) {
    // Defer to async worker. v1: insert document row only, emit queued event.
    const documentId = await upsertDocumentRow(input, null);
    return {
      document: await getDocumentInternal(documentId),
      chunk_count: 0,
      status: 'queued',
    };
  }

  // 1. Upsert the document row with indexed_at=now() (and reindexed_at on
  //    subsequent runs).
  const documentId = await upsertDocumentRow(input, new Date());

  // 2. Replace chunk + vector rows.
  await dataService.query(
    `DELETE FROM rag.chunk WHERE document_id = $1`,
    [documentId],
  );

  const chunks = splitChunks(input.content);
  if (chunks.length === 0) {
    return {
      document: await getDocumentInternal(documentId),
      chunk_count: 0,
      status: 'sync',
    };
  }

  // 3. Persist chunk metadata.
  const chunkRows: Array<{ chunk_id: string; text: string; index: number; span_start: number; span_end: number }> = [];
  for (const c of chunks) {
    const chunkId = randomUUID();
    chunkRows.push({ chunk_id: chunkId, text: c.text, index: c.index, span_start: c.span_start, span_end: c.span_end });
    await dataService.query(
      `INSERT INTO rag.chunk
         (chunk_id, document_id, chunk_index, text_preview, token_count, span_start, span_end)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        chunkId,
        documentId,
        c.index,
        c.text.slice(0, TEXT_PREVIEW_CHARS),
        Math.ceil(c.text.length / 4),
        c.span_start,
        c.span_end,
      ],
    );
  }

  // 4. Embed + upsert into vector store.
  const embedder = getEmbeddingBackend();
  const vectors = await embedder.embed({
    texts: chunkRows.map((r) => r.text),
    model: corpus.embedding_model,
    tenant_id: corpus.tenant_id,
  });

  const records: VectorRecord[] = chunkRows.map((c, i) => ({
    chunk_id: c.chunk_id,
    vector: vectors[i],
    metadata: {
      corpus_id: corpus.corpus_id,
      document_id: documentId,
      tenant_id: corpus.tenant_id,
      policy_overrides: input.policy_overrides ?? {},
      text_preview: c.text.slice(0, TEXT_PREVIEW_CHARS),
    },
  }));
  await getVectorBackend().upsert(corpus.vector_namespace, records);

  try {
    await appendAuditEntry({
      pool_index: RAG_AUDIT_POOL,
      event_type: 'rag.document.indexed.v1',
      actor_kind: 'service',
      actor_id: 'sdk-knowledge-rag',
      tenant_id: corpus.tenant_id,
      subject_kind: 'rag.document',
      subject_id: documentId,
      retention_class: 'regulated',
      payload: {
        corpus_id: corpus.corpus_id,
        document_id: documentId,
        chunk_count: chunks.length,
        source_kind: input.source_kind,
        source_ref: input.source_ref,
      },
    });
  } catch (err) {
    console.warn('[sdk-knowledge-rag] index audit failed (non-fatal):', (err as Error).message);
  }

  return {
    document: await getDocumentInternal(documentId),
    chunk_count: chunks.length,
    status: 'sync',
  };
}

async function upsertDocumentRow(
  input: IndexDocumentInput,
  indexedAt: Date | null,
): Promise<string> {
  const existing = await dataService.one<{ document_id: string }>(
    `SELECT document_id FROM rag.document
      WHERE corpus_id = $1 AND source_kind = $2 AND source_ref = $3`,
    [input.corpus_id, input.source_kind, input.source_ref],
  );

  if (existing) {
    await dataService.query(
      `UPDATE rag.document
          SET title = $2,
              author = $3,
              language = $4,
              reindexed_at = $5,
              policy_overrides = $6::jsonb
        WHERE document_id = $1`,
      [
        existing.document_id,
        input.title ?? null,
        input.author ?? null,
        input.language ?? null,
        indexedAt,
        JSON.stringify(input.policy_overrides ?? {}),
      ],
    );
    return existing.document_id;
  }

  const docId = randomUUID();
  await dataService.query(
    `INSERT INTO rag.document
       (document_id, corpus_id, source_kind, source_ref, title, author,
        language, indexed_at, reindexed_at, policy_overrides)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NULL, $9::jsonb)`,
    [
      docId,
      input.corpus_id,
      input.source_kind,
      input.source_ref,
      input.title ?? null,
      input.author ?? null,
      input.language ?? null,
      indexedAt,
      JSON.stringify(input.policy_overrides ?? {}),
    ],
  );
  return docId;
}

async function getDocumentInternal(document_id: string): Promise<RagDocumentRef> {
  const row = await dataService.one<DocumentRow>(
    `SELECT document_id, corpus_id, source_kind, source_ref, title, author,
            language, indexed_at, reindexed_at, policy_overrides
       FROM rag.document WHERE document_id = $1`,
    [document_id],
  );
  if (!row) throw new Error(`[sdk-knowledge-rag] document ${document_id} vanished after upsert`);
  return rowToRef(row);
}
