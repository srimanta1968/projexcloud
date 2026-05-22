# §3B Localize Complexity — Design Review Checklist

**Status:** ACTIVE. Required for every architecture review (RFC, PR > 500 LoC, new SDK / service).

This checklist is the operational artifact for Architecture v3.1 §3B *Localize Complexity*. The doctrine itself defines the global-vs-local table (11 concepts) and the 4 classification tests. This file is the **PR / RFC review gate**.

**How to apply:** the proposing engineer answers each section; the reviewer signs off. Failed checks block the design until the proposer either (a) revises to localize the complexity or (b) documents an exception with Working Group approval.

---

## 1 · Concept classification (the §3B table)

For every new concept introduced by this change, classify it as **global** (lives in `@projexlight/contracts` and every SDK imports) or **local** (lives inside a single SDK / vertical / app).

| Concept | Global / Local | Rationale (1 line) |
|---|---|---|
| _e.g._ `RoleTemplate` | Global (contracts) | Every SDK reads role names from JWT |
| _e.g._ `HealthcareChartRoot` | Local (vertical) | Healthcare-only; promote only if 2+ verticals adopt |

**Default bias:** *local until proven global by Rule of Three* — three independent consumers using the same shape is the trigger to promote.

---

## 2 · The four classification tests (§3B core)

For each new concept, the proposer must answer Y/N. Any **No** flags the concept as **local** even if it feels like infrastructure.

| Test | Y/N | Justification |
|---|---|---|
| **T1 · Three-consumer test** — Will at least 3 independent SDKs / verticals consume this concept within 6 months? | | |
| **T2 · Cross-pool query test** — Does the concept require resolving identity / authorization / billing across more than one pool? | | |
| **T3 · Contract-breaking change test** — Will changing this concept require coordinated releases across multiple packages? | | |
| **T4 · Type-import test** — Does the concept's TypeScript shape need to appear in another package's public API? | | |

If **fewer than 2 of T1–T4 are Yes**, the concept is **local**.

---

## 3 · §3A Opinionated Constraints — touch tests

Lint enforces these (CI rule references in `tools/lint-rules/`). The proposer confirms each is satisfied **by construction**, not by exception:

- [ ] **OC-1** Every new public method on a billable SDK class carries `@meter(sku, unit, tier)`.
- [ ] **OC-2** Every new `event_type` literal is added to `EVENT_TYPE_REGISTRY` in `@projexlight/contracts` in the same PR.
- [ ] **OC-3** No raw `pg.Client` / `pg.Pool` outside `@projexlight/db-runtime`. Tenant-scoped reads use `withTenant({tenantId, appId}, async (db) => …)`.
- [ ] **OC-4** No cross-SDK imports outside the sanctioned set (`contracts`, `db-runtime`, `telemetry`, `config`, `sdk-identity` middleware, `sdk-audit`, `sdk-secrets`).
- [ ] **OC-5** Any function that calls `withTenant` twice in the same call stack carries `@cross_pool_sanctioned(reason)` with reason ∈ `{resolver, dsar, analytics, lineage}`.
- [ ] **OC-6** No literal `.env` references in source — use `.env.example` + runtime env vars.
- [ ] **OC-7** Every exported interface in `@projexlight/contracts` has a matching Zod schema for runtime validation (if missing, ticketed for follow-up).
- [ ] **OC-8** Any new `CREATE TABLE` with a `tenant_id` column has `ALTER TABLE … ENABLE ROW LEVEL SECURITY` + a tenant-scoped policy in the same migration.
- [ ] **OC-9** No direct KMS SDK imports (`@aws-sdk/client-kms`, `@google-cloud/kms`, etc.) outside `@projexlight/sdk-secrets`.
- [ ] **OC-10** Every emitted event matches the canonical `EventEnvelope` shape (`event_id`, `event_type`, `occurred_at`, `actor`, `pool_index`, six-layer scope).

---

## 4 · §8B Polyglot Persistence — workload routing

The proposer states which storage tier the new workload uses. Wrong-tier placement is the most common §3B drift.

| Workload kind | Correct tier | Used in this change? |
|---|---|---|
| Tenant-scoped OLTP rows with PII | Postgres pool (per-SDK schema, RLS-enforced) | |
| Telemetry / usage events | Kafka topic → ClickHouse rollups | |
| Vector embeddings | pgvector (v1) → Qdrant/Pinecone at scale | |
| Search / full-text | OpenSearch (per-pool index) | |
| Lineage edges | Iceberg lakehouse (cross-pool async projection) | |
| Hot-path caches | Redis (route cache, quota, identity projection) | |
| Blob / media | S3 (per-tenant prefix, vault-wrapped) | |
| Key material | KMS only (never Postgres) | |

If the answer for any new column is "Postgres" outside the OLTP/PII row, **re-classify**.

---

## 5 · Approval

| Role | Reviewer | Date | Signed |
|---|---|---|---|
| Phase DRI | | | ☐ |
| Identity Working Group (if FR-CTR-* touched) | | | ☐ |
| Security (if §5.x KMS / consent / audit touched) | | | ☐ |
| Doctrine Steward (Platform Architect) | | | ☐ |

A change cannot merge until all applicable roles sign off **or** explicit Working Group RFC sign-off for the exception is recorded in the PR.

---

## 6 · Common exceptions (sanctioned by §3A)

These are pre-approved; cite the row to skip §2 re-litigation:

- **Identity resolver fan-out** (sdk-identity-resolver, P3) — sanctioned cross-pool via `@cross_pool_sanctioned('resolver')`.
- **DSAR fan-out** (sdk-data-rights) — `@cross_pool_sanctioned('dsar')`.
- **Analytics warehouse projection** (sdk-analytics) — `@cross_pool_sanctioned('analytics')`.
- **Lineage projection** (sdk-lineage) — `@cross_pool_sanctioned('lineage')`.
- **Test infra creating ephemeral databases** — `@projexlight/lint-rules` disabled-line comment with rationale.

Any new exception class requires a Working Group RFC and an addition to this list.

---

**Cross-references**
- Architecture v3.1 §3A · §3B · §8B (doctrine source)
- Architecture v3.1 §11 (six-layer identity model — touches every Tx that crosses an identity boundary)
- `tools/lint-rules/` — runtime enforcement of OC-1..OC-10
- PRD `P1-Foundation-Spine.md` AC-14 (this checklist closes that AC)
