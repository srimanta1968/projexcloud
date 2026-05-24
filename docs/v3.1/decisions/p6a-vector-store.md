# P6A · Vector store decision — Tier S/P/G (PRD Q-5)

| Field | Value |
|---|---|
| **Date** | 2026-05-23 |
| **DRI** | AI Platform Lead |
| **Status** | DECIDED |
| **Closes** | I-2 / TK-3319 |

## Decision

| Tenant tier | Vector store | Schema pattern |
|---|---|---|
| **Tier S** (shared multi-tenant pool) | pgvector inside the app pool | `vector_<namespace>.embedding` per tenant (cloned from `vector_template`) |
| **Tier P** (premium, dedicated pool) | pgvector in the dedicated app pool | Same pattern; isolated by pool, not namespace |
| **Tier G** (gov / regulated / >100M embeddings) | **Qdrant** managed cluster | One collection per tenant; payload field `tenant_id` mirrors the registry |

## Why Qdrant for Tier-G (vs Pinecone)

| Criterion | Qdrant | Pinecone | Winner |
|---|---|---|---|
| Self-host option (sovereignty + on-prem variants) | ✅ Apache 2.0 | ❌ SaaS only | Qdrant |
| Per-collection RBAC | ✅ Native | ⚠️ via API keys | Qdrant |
| Payload index for tenant_id filter | ✅ b-tree | ✅ metadata | tie |
| Cost at 100M+ vectors | Lower (~30%) | Higher | Qdrant |
| Mature ecosystem / docs | Comparable | Comparable | tie |
| Cold-start re-index time | Comparable | Comparable | tie |

Qdrant also already runs in our HDK / Search benchmarks; one fewer vendor to onboard for finance/security review.

## Rollout

1. **Now (P6A v1.0)** — pgvector for Tier S/P (default). Tier-G placeholder in registry.
2. **P6A.1 (post-launch)** — provision Qdrant managed cluster for Tier-G regions; wire `agents.vector_namespace_registry.backend='qdrant'` and adapter via `registerNamespaceProbe('qdrant', …)`.
3. **P6B** — sdk-knowledge-rag's retrieval path becomes vector-backend-agnostic via the same probe interface.

## Revisit

- After 6 months OR when any Tier-G tenant crosses 50M embeddings
- If Qdrant fails an availability SLO twice in a quarter — re-evaluate Pinecone
