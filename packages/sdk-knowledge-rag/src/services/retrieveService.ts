import { randomUUID } from 'crypto';
import { dataService } from '@projexlight/db-runtime';
import { appendAuditEntry } from '@projexlight/sdk-audit';
import type {
  RagHit,
  RagRetrievalRequest,
  RagRetrievalResponse,
} from '@projexlight/contracts';
import { getEmbeddingBackend, getVectorBackend, type VectorRecord } from './backends';
import { getCorpus } from './corpusService';

/**
 * Retrieval with policy-filtered hits (FR-RAG-4, FR-RAG-5 / AC-2).
 *
 * Pipeline:
 *   1. Resolve corpus → vector_namespace + policy_id + embedding_model
 *   2. Embed the query with the same backend used at indexing
 *   3. Query the vector store for top_k * OVERFETCH_MULTIPLIER candidates
 *      (we over-fetch because the policy filter may drop some hits)
 *   4. Apply the policy filter per hit: corpus.policy_id is checked
 *      against the requestor persona; per-document policy_overrides
 *      further narrow access. Defaults are policy-permissive in v1 —
 *      production wires sdk-policy.evaluate(policy_id, ctx).
 *   5. Persist rag.retrieval row for audit + cost telemetry
 *   6. Emit rag.retrieval.completed.v1
 *
 * Latency target: ≤500ms p99 (PRD §6).
 */

const RAG_AUDIT_POOL = process.env.RAG_AUDIT_POOL || 'admin-default';
const OVERFETCH_MULTIPLIER = parseFloat(process.env.RAG_RETRIEVE_OVERFETCH ?? '3');

export interface RetrieveOptions {
  /**
   * Per-call policy resolver. When omitted, the default permissive
   * resolver is used. Production wires sdk-policy.evaluate at this seam.
   */
  policyResolver?: PolicyResolver;
  /**
   * Requestor's role membership — used by the default resolver to
   * enforce "only admin may read restricted docs" style overrides.
   */
  requestor_roles?: string[];
}

export interface PolicyResolverInput {
  policy_id: string;
  document_policy_overrides: Record<string, unknown>;
  requestor_persona_id: string;
  requestor_roles: string[];
  tenant_id: string;
}

export type PolicyResolver = (input: PolicyResolverInput) => Promise<boolean> | boolean;

/**
 * Default v1 policy resolver. Honors a tiny set of override keys so the
 * AC-2 fixtures + tests can exercise the filter:
 *   - `allowed_roles`: array of role names; if set, requestor must have
 *     at least one of them
 *   - `restricted`: when true with no `allowed_roles`, only `admin` may read
 * Production replaces this with the sdk-policy bridge.
 */
async function defaultPolicyResolver(input: PolicyResolverInput): Promise<boolean> {
  const overrides = input.document_policy_overrides ?? {};
  const allowedRoles = overrides.allowed_roles;
  if (Array.isArray(allowedRoles) && allowedRoles.length > 0) {
    return allowedRoles.some((r) => typeof r === 'string' && input.requestor_roles.includes(r));
  }
  if (overrides.restricted === true) {
    return input.requestor_roles.includes('admin');
  }
  return true;
}

export async function retrieve(
  request: RagRetrievalRequest,
  options: RetrieveOptions = {},
): Promise<RagRetrievalResponse> {
  const startedAt = Date.now();
  const corpus = await getCorpus(request.corpus_id);
  if (!corpus) throw new Error(`[sdk-knowledge-rag] corpus ${request.corpus_id} not found`);

  // 1. Embed query (same backend as indexing).
  const embedder = getEmbeddingBackend();
  const [queryVec] = await embedder.embed({
    texts: [request.query_text],
    model: corpus.embedding_model,
    tenant_id: corpus.tenant_id,
  });

  // 2. Over-fetch candidates.
  const candidates = await getVectorBackend().query({
    namespace: corpus.vector_namespace,
    query_vector: queryVec,
    top_k: Math.max(request.top_k, Math.ceil(request.top_k * OVERFETCH_MULTIPLIER)),
  });

  // 3. Resolve per-hit policy. Track filtered-out count for audit.
  const resolver = options.policyResolver ?? defaultPolicyResolver;
  const requestorRoles = options.requestor_roles ?? [];
  const hits: RagHit[] = [];
  let filteredOut = 0;

  for (const c of candidates) {
    if (hits.length >= request.top_k) break;
    const allowed = await resolver({
      policy_id: corpus.policy_id,
      document_policy_overrides: (c.metadata.policy_overrides ?? {}) as Record<string, unknown>,
      requestor_persona_id: request.requestor_persona_id,
      requestor_roles: requestorRoles,
      tenant_id: corpus.tenant_id,
    });
    if (!allowed) {
      filteredOut++;
      continue;
    }
    hits.push(hitFromRecord(c, c.score));
  }

  const latencyMs = Date.now() - startedAt;
  const retrievalId = await persistRetrieval({
    corpus_id: corpus.corpus_id,
    tenant_id: corpus.tenant_id,
    requestor_persona_id: request.requestor_persona_id,
    agent_run_id: request.agent_run_id ?? null,
    query_text: request.query_text,
    top_k: request.top_k,
    hits_returned: hits.length,
    hits_filtered_out: filteredOut,
    trace_id: request.trace_id,
    latency_ms: latencyMs,
  });

  try {
    await appendAuditEntry({
      pool_index: RAG_AUDIT_POOL,
      event_type: 'rag.retrieval.completed.v1',
      actor_kind: 'service',
      actor_id: 'sdk-knowledge-rag',
      tenant_id: corpus.tenant_id,
      subject_kind: 'rag.retrieval',
      subject_id: retrievalId,
      retention_class: 'operational',
      payload: {
        retrieval_id: retrievalId,
        corpus_id: corpus.corpus_id,
        requestor_persona_id: request.requestor_persona_id,
        hits_returned: hits.length,
        hits_filtered_out: filteredOut,
        latency_ms: latencyMs,
        trace_id: request.trace_id,
      },
    });
  } catch (err) {
    console.warn('[sdk-knowledge-rag] retrieve audit failed (non-fatal):', (err as Error).message);
  }

  return {
    retrieval_id: retrievalId,
    hits,
    hits_returned: hits.length,
    hits_filtered_out: filteredOut,
    latency_ms: latencyMs,
  };
}

function hitFromRecord(record: VectorRecord, score: number): RagHit {
  return {
    chunk_id: record.chunk_id,
    document_id: record.metadata.document_id,
    corpus_id: record.metadata.corpus_id,
    text_preview: record.metadata.text_preview,
    score,
    policy_filtered: false,
    source_ref: `${record.metadata.document_id}#${record.chunk_id}`,
  };
}

async function persistRetrieval(input: {
  corpus_id: string;
  tenant_id: string;
  requestor_persona_id: string;
  agent_run_id: string | null;
  query_text: string;
  top_k: number;
  hits_returned: number;
  hits_filtered_out: number;
  trace_id: string;
  latency_ms: number;
}): Promise<string> {
  const id = randomUUID();
  await dataService.query(
    `INSERT INTO rag.retrieval
       (retrieval_id, corpus_id, requestor_persona_id, agent_run_id,
        query_text, top_k, hits_returned, hits_filtered_out, trace_id, latency_ms)
     VALUES ($1, $2, $3::uuid, $4, $5, $6, $7, $8, $9, $10)`,
    [
      id,
      input.corpus_id,
      input.requestor_persona_id,
      input.agent_run_id,
      input.query_text,
      input.top_k,
      input.hits_returned,
      input.hits_filtered_out,
      input.trace_id,
      input.latency_ms,
    ],
  );
  return id;
}
