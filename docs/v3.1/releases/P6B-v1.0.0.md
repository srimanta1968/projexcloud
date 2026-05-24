# P6B initial drop — v1.0.0

| Field | Value |
|---|---|
| **Phase** | P6B |
| **Window** | Weeks 40–44 (~4 weeks) |
| **Maps to wave** | W6 second half |
| **Gates closed (this drop)** | G8 (cross-pool lineage projection) · G9 (SemanticIntent + SemanticPolicy) |
| **Anchor docs** | `docs/v3.1/prd/P6B-Knowledge-Semantic.md` · `docs/v3.1/datamodel/P6B-Knowledge-Semantic-DataModel.html` · `docs/v3.1/SDK-Build-Plan-v3.1.html` |

---

## 1 · What landed

| Component | Form | Status |
|---|---|---|
| `@projexlight/contracts/src/p6b-knowledge.ts` | New TS module (~110 typed interfaces) | **Complete** |
| `@projexlight/contracts/src/events.ts` | +27 P6B event types added to `EVENT_TYPE_REGISTRY` | **Complete** |
| `@projexlight/sdk-meter/src/db/migrations/003_p6b_skus.sql` | 19 P6B SKU rates in catalog `platform-p6b-2026q2` | **Complete** |
| `@projexlight/sdk-lineage` (G8 closer) | Full package — schema, services, projector queue support | **Complete** |
| `@projexlight/sdk-semantic` (G9 closer) | Full package — 6 typed primitives, ontology / intent-planner / policy / bridge services | **Complete** |
| `services/lineage-projector` | Worker that drains `lineage.cross_pool_projection_queue` to Iceberg | **Complete** (local Iceberg writer; Glue/Nessie pluggable) |
| `services/semantic-service` | HTTP service exposing ontology · plan · policy · bridge endpoints | **Complete** |
| `@projexlight/sdk-knowledge-rag` | Scaffold + schema migration (`rag.corpus/document/chunk/retrieval`) | Migration complete; executors deferred to follow-up tasks |
| `@projexlight/sdk-parsing` | Scaffold + schema migration (8-stage pipeline tables) | Migration complete; executors deferred |
| `@projexlight/sdk-conversation` | Scaffold + schema migration (session/turn/handoff) | Migration complete; executors deferred |
| `@projexlight/sdk-recommendation` | Scaffold + schema migration (model/suggestion/feedback) | Migration complete; executors deferred |
| `@projexlight/sdk-analytics` | Scaffold + schema migration (rollup_spec/extract/cohort/funnel/kpi) | Migration complete; executors deferred |
| `@projexlight/connector-snowflake` | Scaffold + schema migration (install/binding/sync_run/query_log) | Migration complete; executors deferred |

All 8 P6B SDKs and 2 services build with `tsc --noEmit` clean across the workspace.

---

## 2 · G8 closer — sdk-lineage

**Closes:** Gate G8 — cross-pool lineage projection.

**Public surface (`packages/sdk-lineage/src/index.ts`):**
- `emit(input: LineageEmitInput)` — atomically upserts from + to nodes, inserts the edge, and (when source/target pools differ) enqueues a `cross_pool_projection_queue` row. Cross-tenant emit is blocked at the SDK layer per Architecture §11 / P15.
- `chain(ref_kind, ref_id)` — BFS in-pool ancestor walk bounded by `LINEAGE_CHAIN_MAX_HOPS` (default 64). PRD §6 target ≤50ms p99.
- `crossPoolChain(ref_kind, ref_id)` — hydrates cross-pool ancestors from the projection queue (Postgres mirror; Iceberg-backed read federation lands in P7).
- `claimProjectionBatch / markProjected / markFailed / rescheduleProjection` — queue draining primitives used by services/lineage-projector. Use `SELECT FOR UPDATE SKIP LOCKED` for safe horizontal scaling.

**Schema (`lineage.node`, `lineage.edge`, `lineage.cross_pool_projection_queue`):**
- `lineage.node` enforces unique `(ref_kind, ref_id)` so idempotent emit just resolves to the existing row.
- `lineage.edge` indexed on `(to_node_id, occurred_at DESC)` and `(from_node_id, occurred_at DESC)` so BFS hops stay sub-50ms.
- `lineage.cross_pool_projection_queue` indexed on `state='pending'` partial index so the worker's claim query stays O(claim_batch).

**Worker (`services/lineage-projector`):**
- Drains pending queue rows in `enqueued_at` order, writes each to `warehouse.cross_pool_lineage` (via pluggable `IcebergWriter` — default `LocalIcebergWriter` writes NDJSON for dev/CI).
- Tracks `projected · rescheduled · failed` counters; `/health` and `/metrics` endpoints expose them.
- Multiple replicas safe — `SELECT FOR UPDATE SKIP LOCKED` partitions work without external locks.
- `MAX_ATTEMPTS` (default 5) before parking a row as `state='failed'`.

**Events added to registry:**
- `lineage.edge.emitted.v1` — every edge produced
- `lineage.projection.queued.v1` — cross-pool edge enqueued
- `lineage.projection.completed.v1` — projected to Iceberg
- `lineage.projection.failed.v1` — exhausted retries

---

## 3 · G9 closer — sdk-semantic

**Closes:** Gate G9 — SemanticIntent + SemanticPolicy.

**Six typed primitives in one schema:**
1. **SemanticObject** — `semantic.object_type` with `attribute_schema` JSON + `backed_by` pointer to MDM/persona-ext table.
2. **SemanticRelation** — `semantic.relation_type` with cardinality + optional `rebac_kind_mapping` for ReBAC composition.
3. **CapabilityGraph** — `semantic.capability_graph_edge` linking object types to valid `tool_sku` operations with `requires_relation` + pre/post conditions.
4. **DomainOntology** — `semantic.ontology` versioned bundles (Healthcare / Realty / Seva v1 land via follow-up registration tasks).
5. **SemanticIntent** — `semantic.intent` + `semantic.intent_plan` with five-state lifecycle (proposed → approved → executing → completed | abandoned).
6. **SemanticPolicy** — `semantic.policy` with `iql_source` compiled to `compiled_abac` + `compiled_rebac` on register.

**v1 IQL grammar (`compileIql`):**
```
ALLOW <subject_type> WITH <relation_name>(<object_type>) TO <verb> <object_type>
DENY  <subject_type> TO <verb> <object_type>
```
PRD AC-9 example compiles correctly — verified by `tests/iql-compiler.test.ts` (5/5 green).

**Planner (`plan(intent, ctx)`):**
- Resolves subject object type → fetches all `capability_graph_edge` rows for that type → filters by goal-keyword match + pre-condition satisfaction → topologically orders so post→pre dependencies satisfy first.
- Returns a `Plan` with ordered `PlanStep[]`, each step validated against a real `capability_edge_id` so the agent runtime can mint capability tokens against the exact edge that approved it.
- PRD §6 target ≤1s p99.

**Evaluator (`evaluate(policy_id, ctx)`):**
- Pulls the policy, evaluates the compiled ABAC predicate against `(subject_type, action, resource_type)`, then verifies every `require_edge` is present in the caller's `active_edges`.
- Audits every decision via `semantic.policy.evaluated.v1` (operational retention, LWW conflict policy).
- PRD §6 target ≤5ms p99.

**Bridges (`semantic.cross_domain_bridge`):**
- Default `access_mode='read-only'` and `requires_cross_tenant_consent=true` per PRD R-7 mitigation.

**HTTP surface (`services/semantic-service`):**
- `POST /ontology/register` — bundle registration
- `POST /intent/plan` — Intent → Plan
- `POST /policy/:id/evaluate` — policy evaluation
- `POST /bridge` — cross-domain bridge creation
- Plus `GET` listers and lifecycle endpoints

**Events added to registry:**
- `semantic.ontology.registered.v1` · `semantic.ontology.deprecated.v1`
- `semantic.intent.planned.v1` · `semantic.plan.executed.v1`
- `semantic.policy.evaluated.v1` · `semantic.bridge.created.v1`

---

## 4 · Pricing — `platform-p6b-2026q2` catalog

All 19 P6B SKUs registered with `ON CONFLICT DO NOTHING` so re-runs are safe. Categories:

| SDK | SKUs | Mode |
|---|---|---|
| sdk-knowledge-rag | `rag.index.document` (per-MB) · `rag.embed` (passthrough+margin 15%) · `rag.retrieve` (tiered) | mixed |
| sdk-parsing | `parsing.document.parse · parsing.re-extract` | per_unit (complexity tiered) |
| sdk-conversation | `conversation.message.send` (tiered) · `conversation.handoff` (flat) | tiered + flat |
| sdk-recommendation | `recommendation.suggest` (tiered) · `recommendation.train` (per-run) | tiered + per_unit |
| sdk-analytics | `analytics.rollup.query` (flat) · `analytics.lakehouse.query` (per-GB) | flat + per_unit |
| sdk-lineage | `lineage.edge.write` · `lineage.chain.query` · `lineage.cross-pool.query` | flat (very cheap) |
| sdk-semantic | `semantic.intent.plan · semantic.policy.evaluate` (tiered) · `semantic.ontology.register` (flat) | tiered + flat |
| connector-snowflake | `snowflake.query` (passthrough+margin per byte) · `snowflake.sync.row` (per row) | passthrough + per_unit |

---

## 5 · Auto-migration wiring

P6B migrations are applied on api-gateway boot per the auto-migrate doctrine. Order in `services/api-gateway/src/app.ts`:

```ts
{ sdk: 'sdk-lineage',         dir: lineageMigrations },
{ sdk: 'sdk-semantic',        dir: semanticMigrations },
{ sdk: 'sdk-knowledge-rag',   dir: ragMigrations },
{ sdk: 'sdk-parsing',         dir: parsingMigrations },
{ sdk: 'sdk-conversation',    dir: conversationMigrations },
{ sdk: 'sdk-recommendation',  dir: recommendationMigrations },
{ sdk: 'sdk-analytics',       dir: analyticsMigrations },
{ sdk: 'connector-snowflake', dir: connectorSnowflakeMigrations },
```

Reasoning for the order — see the comment block in `services/api-gateway/src/app.ts` (lineage first because other SDKs reference `lineage.node`).

---

## 6 · Acceptance criteria status

| AC | Status | Note |
|---|---|---|
| AC-1 · Parsing 8-stage extracts | DB schema landed; full pipeline executors deferred to feat_parsing follow-ups |
| AC-2 · RAG policy-filtered | DB schema landed; retrieve impl deferred |
| AC-3 · Conversation sandboxed memory | DB schema landed; session impl deferred |
| AC-4 · Analytics cross-pool via Iceberg | DB schema + runtime guard deferred to executors |
| **AC-5 · Cross-pool lineage ≤5min** | **G8 closer infrastructure live** — queue, projector worker, Iceberg writer interface |
| **AC-6 · Derivation chain query** | **`chain()` + `crossPoolChain()` shipped**, in-pool ≤50ms |
| AC-7 · 3 ontologies v1 loaded | Registry + bundle format ready; bundle JSON authoring is a vertical-team task |
| **AC-8 · Intent → Plan** | **Planner shipped**, no LLM exemplars used |
| **AC-9 · SemanticPolicy authz** | **Compiler + evaluator shipped**, PRD example verified by unit test |
| AC-10 · Cross-vertical inference | Bridge primitive shipped (`semantic.cross_domain_bridge`); end-to-end scenario test deferred |
| AC-11 · Snowflake roundtrip | DB schema + tool manifest deferred to executors |
| AC-12 · Recommendation NBA | DB schema landed; train/suggest impl deferred |
| AC-13 · v1.0.0 published | Packages versioned `1.0.0`; `npm view` validation deferred to publish task |

---

## 7 · Tests added

- `packages/sdk-semantic/tests/iql-compiler.test.ts` — 5/5 green; verifies the PRD AC-9 example compiles correctly and that the v1 grammar rejects unknown shapes.
- `packages/sdk-lineage/tests/contracts.test.ts` — 9/9 green; verifies the public surface, cross-tenant emit block (runtime guard), event registry coverage for G8 events, and the documented edge-kind/node-kind enums.

Full workspace `pnpm -w build` passes 88/88. `pnpm -w test` passes everything except the pre-existing sdk-taxonomy test config bug (unrelated to P6B; reproducible on baseline).

---

## 8 · What's deferred to follow-up tasks

Per the projexlight per-task workflow created at conversation start:

- **TK-3329** P6B contracts (✅ this drop)
- **TK-3330** P6B meter SKU seed (✅ this drop)
- **TK-3331** sdk-knowledge-rag scaffold + migration (✅ this drop) — `retrieve` / `indexDocument` impl follows
- **TK-3332** sdk-parsing scaffold + migration (✅ this drop) — pipeline executors follow
- **TK-3333** sdk-conversation scaffold + migration (✅ this drop) — `openSession` / `sendMessage` follow
- **TK-3334** sdk-recommendation scaffold + migration (✅ this drop) — `trainModel` / `suggest` follow
- **TK-3335** sdk-analytics scaffold + migration (✅ this drop) — `rollup` / `query` / `extractToLakehouse` follow
- **TK-3336** sdk-lineage scaffold + migration (✅ this drop) — **plus full service**
- **TK-3337** sdk-semantic scaffold + migration (✅ this drop) — **plus full service**
- **TK-3338** connector-snowflake scaffold + migration (✅ this drop) — `installSnowflake` / `query` follow
- **TK-3339** services/lineage-projector (✅ this drop)
- **TK-3340** services/semantic-service (✅ this drop)

Subsequent waves: end-to-end AC integration tests (AC-1, AC-2, AC-3, AC-4, AC-7, AC-10, AC-11, AC-12, AC-13).

---

## 9 · Operator notes

**Required env vars for the new services:**
- `LINEAGE_PROJECTOR_DB_URL` (or `DATABASE_URL`) — Postgres URL for the projector worker.
- `LINEAGE_ICEBERG_DRIVER` — `local` (default) writes NDJSON; production swaps to `glue` or `nessie` (drivers not in this drop — pluggable via `buildIcebergWriter`).
- `LINEAGE_ICEBERG_LOCAL_DIR` — directory the local driver writes to (default `./.iceberg-stub/cross_pool_lineage`).
- `LINEAGE_PROJECTOR_BATCH` / `LINEAGE_PROJECTOR_INTERVAL_MS` / `LINEAGE_PROJECTOR_IDLE_MS` / `LINEAGE_PROJECTOR_MAX_ATTEMPTS` — tuning knobs.
- `SEMANTIC_SERVICE_DB_URL` (or `DATABASE_URL`) — Postgres URL for the semantic service.
- `SEMANTIC_AUDIT_POOL` — audit pool for ontology/intent/policy events (default `admin-default`).

**Health endpoints:**
- `GET /health` on both `lineage-projector` (port 8081) and `semantic-service` (port 8082).
- `GET /metrics` on `lineage-projector` exposes the running `projected · failed · rescheduled` tallies.
