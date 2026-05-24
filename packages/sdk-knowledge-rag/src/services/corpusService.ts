import { randomUUID } from 'crypto';
import { dataService } from '@projexlight/db-runtime';
import { appendAuditEntry } from '@projexlight/sdk-audit';
import type { RagCorpusRef } from '@projexlight/contracts';

/**
 * RAG corpus CRUD (FR-RAG-1, FR-RAG-7).
 *
 * One corpus per tenant + topic. The vector_namespace is HARD-isolated —
 * we derive it from corpus_id + tenant_id so collisions are impossible
 * within a tenant and physically partitioned across tenants. The caller
 * can also pass an explicit namespace when migrating from a legacy
 * corpus or pinning to a Tier-G dedicated cluster.
 */

const RAG_AUDIT_POOL = process.env.RAG_AUDIT_POOL || 'admin-default';

export interface CreateCorpusInput {
  tenant_id: string;
  name: string;
  description?: string;
  embedding_model?: string;
  embedding_dim?: number;
  /** sdk-policy policy_id applied per-hit at retrieve time. */
  policy_id: string;
  /** Override default namespace (rag-${tenant_id}-${corpus_id}). */
  vector_namespace?: string;
}

interface CorpusRow {
  corpus_id: string;
  tenant_id: string;
  name: string;
  description: string | null;
  vector_namespace: string;
  embedding_model: string;
  embedding_dim: number;
  policy_id: string;
  created_at: Date;
}

function rowToRef(r: CorpusRow): RagCorpusRef {
  return {
    corpus_id: r.corpus_id,
    tenant_id: r.tenant_id,
    name: r.name,
    description: r.description ?? undefined,
    vector_namespace: r.vector_namespace,
    embedding_model: r.embedding_model,
    embedding_dim: r.embedding_dim,
    policy_id: r.policy_id,
    created_at: r.created_at.toISOString(),
  };
}

export async function createCorpus(input: CreateCorpusInput): Promise<RagCorpusRef> {
  const corpusId = randomUUID();
  const vectorNamespace = input.vector_namespace
    ?? `rag-${input.tenant_id}-${corpusId}`;
  const embeddingModel = input.embedding_model ?? 'platform-hash-bucket-v1';
  const embeddingDim = input.embedding_dim ?? 64;

  const row = await dataService.one<CorpusRow>(
    `INSERT INTO rag.corpus
       (corpus_id, tenant_id, name, description, vector_namespace,
        embedding_model, embedding_dim, policy_id)
     VALUES ($1, $2::uuid, $3, $4, $5, $6, $7, $8::uuid)
     RETURNING corpus_id, tenant_id::text, name, description, vector_namespace,
               embedding_model, embedding_dim, policy_id::text, created_at`,
    [
      corpusId,
      input.tenant_id,
      input.name,
      input.description ?? null,
      vectorNamespace,
      embeddingModel,
      embeddingDim,
      input.policy_id,
    ],
  );
  if (!row) throw new Error('[sdk-knowledge-rag] createCorpus insert failed');

  try {
    await appendAuditEntry({
      pool_index: RAG_AUDIT_POOL,
      event_type: 'rag.corpus.created.v1',
      actor_kind: 'service',
      actor_id: 'sdk-knowledge-rag',
      tenant_id: input.tenant_id,
      subject_kind: 'rag.corpus',
      subject_id: corpusId,
      retention_class: 'regulated',
      payload: {
        corpus_id: corpusId,
        name: input.name,
        vector_namespace: vectorNamespace,
        embedding_model: embeddingModel,
      },
    });
  } catch (err) {
    console.warn('[sdk-knowledge-rag] corpus audit failed (non-fatal):', (err as Error).message);
  }

  return rowToRef(row);
}

export async function getCorpus(corpus_id: string): Promise<RagCorpusRef | null> {
  const row = await dataService.one<CorpusRow>(
    `SELECT corpus_id, tenant_id::text, name, description, vector_namespace,
            embedding_model, embedding_dim, policy_id::text, created_at
       FROM rag.corpus WHERE corpus_id = $1`,
    [corpus_id],
  );
  return row ? rowToRef(row) : null;
}

export async function listCorpora(tenant_id: string): Promise<RagCorpusRef[]> {
  const rows = await dataService.rows<CorpusRow>(
    `SELECT corpus_id, tenant_id::text, name, description, vector_namespace,
            embedding_model, embedding_dim, policy_id::text, created_at
       FROM rag.corpus
      WHERE tenant_id = $1::uuid
      ORDER BY created_at DESC`,
    [tenant_id],
  );
  return rows.map(rowToRef);
}
