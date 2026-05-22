# PRD · P6B — Knowledge + Semantic + Analytics + Snowflake

| Field | Value |
|---|---|
| **Phase** | P6B |
| **Window** | Weeks 40–44 (~4 weeks) |
| **Maps to wave(s)** | W6 second half |
| **Gates closed** | G8 (cross-pool lineage projection) · G9 (SemanticIntent + SemanticPolicy) |
| **Status** | DRAFT |
| **Owner (DRI)** | AI Platform + Data Platform Leads |
| **Companion docs** | `../docs/v3.1/AgenticIntegration-v3.1.html` (semantic layer) · `../docs/v3.1/Architecture-v3.1.html` §10A (metering) §8B (polyglot persistence) |

---

## 1 · TL;DR

P6B fills out the **knowledge + reasoning + analytics** stack on top of P6A's safe agent substrate. Knowledge/RAG gives agents per-tenant policy-filtered retrieval. Parsing turns documents into structured facts. Conversation owns the chat surface. Recommendation drives next-best-action. Analytics gets the **Iceberg lakehouse** for PB-scale cross-pool reads. Lineage closes G8 with **cross-pool projection** (in-pool sync queries; cross-pool via lakehouse async). And the **Semantic Domain Layer** finally lights up with all 6 types — **Object · Relation · CapabilityGraph · Ontology · Intent · Policy** — making agents reason against typed domain concepts rather than raw entities, closing G9.

---

## 2 · Why this phase now

P6A made agents safe; P6B makes them smart. Agents need: (a) retrieval (RAG) over tenant corpora; (b) understanding of typed domain concepts (Semantic); (c) ability to plan from goals (SemanticIntent → CapabilityGraph); (d) auditability of derivations (Lineage). The Iceberg lakehouse lands here because cross-pool analytics at PB scale exceeds what per-pool ClickHouse can hold (ClickHouse stays for hot rollups ≤90d; Iceberg is cold + cross-pool). connector-snowflake ships here as the bridge to customer's existing data warehouses.

---

## 3 · What ships in this phase

| Component | Type | Effort | Owner | Notes |
|---|---|---|---|---|
| `@projexlight/sdk-knowledge-rag` | SDK · NEW | L · 5w | AI Platform | Per-tenant corpora; pgvector store (Tier-G dedicated cluster); embedding worker; retrieval API with policy-filtered hits |
| `@projexlight/sdk-parsing` | SDK · NEW | L · 7w | AI Platform | 8-stage pipeline (Ingestion · OCR · Classification · Schema Resolve · Extraction · Validation · Human Review · Routing); confidence scoring; re-parse modes; Needs-Review queue |
| `@projexlight/sdk-conversation` | SDK · NEW | M · 4w | AI Platform | Chat sessions; handoff; transcripts; multi-turn memory (sandboxed per P6A) |
| `@projexlight/sdk-recommendation` | SDK · NEW | M · 4w | AI Platform | Similar-X; next-best-action; per-tenant model artifacts |
| `@projexlight/sdk-analytics` | SDK · MODIFIED v3.1 | M · 4w | Data Platform | ClickHouse OLAP (hot rollups ≤90d) + **Iceberg / S3-tables lakehouse layer** (closes G11 partially — full P7); cohort/funnel/KPI primitives; per-tenant rollups; cross-pool aggregation via warehouse only |
| `@projexlight/sdk-lineage` | SDK · NEW v3.1 | M · 4w | Data Platform | Field-level provenance graph; per-pool in-pool subgraph for sync queries; **cross-pool projection worker** projects asynchronously into Iceberg `cross_pool_lineage` table (closes G8) |
| `@projexlight/sdk-semantic` | SDK · NEW v3.1 | XL · 6w | Platform Architect | The Enterprise Semantic Model Layer — full 6 types: **Object · Relation · CapabilityGraph · Ontology · SemanticIntent · SemanticPolicy** (closes G9) |
| `@projexlight/connector-snowflake` | Connector · NEW v3.1 | L · 5w | Integrations | Query federation; Iceberg bridge for bidirectional data; agent tool: "query the customer's warehouse" |
| `services/lineage-projector` | Service · NEW | M · 3w | Data Platform | Cross-pool lineage worker → Iceberg |
| `services/semantic-service` | Service · NEW | L · 5w | Platform | Ontology registry · SemanticIntent planner |

---

## 4 · User stories

### As an **Agent Developer**
- **US-AD-1**: I express a goal as a `SemanticIntent` (`goal: 'schedule_follow_up_visit'`); the agent walks the CapabilityGraph to produce a multi-step plan automatically — no prompt-engineered exemplars.
- **US-AD-2**: My agent calls `knowledge-rag.retrieve()` for tenant-specific context; results are policy-filtered (only docs the persona may read).
- **US-AD-3**: I query lineage: "show me the derivation chain for this scoring decision" — get back the path through Parsing → AI Gateway → sdk-recommendation.

### As a **Vertical Product Engineer** (Healthcare)
- **US-VE-1**: I register Healthcare Ontology v1 in sdk-semantic — Patient, Encounter, Prescription, Lab Result, Diagnosis as SemanticObjects with their Relations and operations.
- **US-VE-2**: I declare cross-vertical bridges (Patient in Healthcare ↔ Person in Realty for housing-stability indicators); cross-vertical reasoning becomes tractable.

### As a **ProjexCloud Operator**
- **US-OP-1**: I query the Iceberg lakehouse: "all encounters across all healthcare tenants in EU region in Q3" → results in <30s for 100M+ records. Per-pool ClickHouse couldn't have answered this; lakehouse does.
- **US-OP-2**: I trigger a cross-pool lineage query: "show me everywhere this AI agent's recommendation propagated to" → results from the lakehouse projection.

### As a **Tenant Admin**
- **US-TA-1**: I connect Snowflake via connector-snowflake; my agents can query my warehouse; sync runs bidirectionally with Iceberg.
- **US-TA-2**: I upload our company knowledge base to sdk-knowledge-rag; my agents have grounded answers based on our own corpus.
- **US-TA-3**: I see lineage for any record in my tenant; if a regulator asks "how did this calculation happen," one query produces the full chain.

### As a **Tenant Employee** (using conversation UI)
- **US-EU-1**: I chat with the platform's AI assistant in the Tenant Workspace; the assistant has my context (resolver), retrieves from our knowledge base (RAG), reasons against our ontology (semantic), can take actions across our apps (P6A agent runtime) — all in one surface.

### As a **Finance Engineer**
- **US-FE-1**: I generate cross-tenant cost analytics for the platform (all-tenant view); query the Iceberg lakehouse; per-vertical, per-month aggregations work without touching pools.

---

## 5 · Functional requirements (per SDK / component)

### 5.1 · `@projexlight/sdk-knowledge-rag`

**Owns:**
- FR-RAG-1: Per-tenant corpora (tenant uploads docs · platform indexes)
- FR-RAG-2: pgvector for v1 (per-pool); dedicated vector cluster for Tier-G
- FR-RAG-3: Embedding worker (via sdk-ai-gateway)
- FR-RAG-4: Retrieval API: `retrieve(query, context) → policy-filtered hits`
- FR-RAG-5: Policy filtering applies sdk-policy on every hit (only docs the calling persona may read)
- FR-RAG-6: Re-indexing on doc updates
- FR-RAG-7: Per-tenant namespace HARD-isolated (re-uses sandboxed memory from P6A)

**Pool placement:** App Pool (corpus metadata); Vector store namespace per tenant.

**SKUs:** `rag.index.document` (per-MB) · `rag.embed` (per-token, passthrough+margin) · `rag.retrieve` (per-call) — mixed.

### 5.2 · `@projexlight/sdk-parsing`

**Owns:**
- FR-PRS-1: 8-stage pipeline (Ingestion · OCR · Classification · Schema Resolve · Extraction · Validation · Human Review · Routing)
- FR-PRS-2: Schema selection from sdk-taxonomy at runtime (no hard-coded schemas)
- FR-PRS-3: Confidence scoring per field; configurable thresholds
- FR-PRS-4: Re-parse modes (full re-parse · re-extract only · re-validate only)
- FR-PRS-5: Needs-Review queue (composes with sdk-approval for human-in-the-loop)
- FR-PRS-6: Emits lineage edges for every extracted field

**SKUs:** `parsing.document.parse` · `parsing.re-extract` — `per_unit` (per-document, complexity-tiered).

### 5.3 · `@projexlight/sdk-conversation`

**Owns:**
- FR-CVS-1: Chat session lifecycle (started · active · handed-off · closed)
- FR-CVS-2: Multi-turn memory (per-session, sandboxed per P6A)
- FR-CVS-3: Handoff (AI → human agent; human agent → AI for non-blocking parts)
- FR-CVS-4: Transcript storage (per-tenant App Pool)
- FR-CVS-5: Real-time streaming responses (sdk-ai-gateway stream)
- FR-CVS-6: Integration with sdk-knowledge-rag for grounded answers

**SKUs:** `conversation.message.send` · `conversation.handoff` — `tiered_per_call`.

### 5.4 · `@projexlight/sdk-recommendation`

**Owns:**
- FR-REC-1: Similar-X (find similar entities by feature vector)
- FR-REC-2: Next-best-action recommender
- FR-REC-3: Per-tenant model artifacts (train on tenant data; vector-isolated)
- FR-REC-4: A/B variant testing via sdk-feature-flags

**SKUs:** `recommendation.suggest` · `recommendation.train` — `tiered_per_call` + `per_unit` for training.

### 5.5 · `@projexlight/sdk-analytics`

**Owns:**
- FR-ANL-1: ClickHouse OLAP wiring (hot rollups; ≤90 days)
- FR-ANL-2: Cohort / funnel / KPI primitives
- FR-ANL-3: Per-tenant rollups (analyst queries via tenant-scoped views)
- FR-ANL-4: Cross-pool aggregation via warehouse only — no live cross-pool joins (architectural rule §8A)
- FR-ANL-5: **Iceberg / S3-tables lakehouse layer** (G11 partial — full federation runtime P7)
- FR-ANL-6: PB-scale analytics spill into Iceberg; queryable from Trino/Athena
- FR-ANL-7: Per-tenant analytical extracts (consent-gated)

**Public API surface:**
```ts
export async function rollup(spec: RollupSpec): Promise<RollupResult>;
export async function query(spec: AnalyticsQuery): Promise<QueryResult>;
export async function extractToLakehouse(spec: ExtractSpec): Promise<IcebergTableRef>;
```

**Pool placement:** ClickHouse (hot); Iceberg lakehouse (cold + cross-pool).

**SKUs:** `analytics.rollup.query` (per-call) · `analytics.lakehouse.query` (per-GB scanned) — mixed.

### 5.6 · `@projexlight/sdk-lineage`

**Owns:**
- FR-LIN-1: Field-level provenance graph; edge types: `extracted_from · derived_from · merged_from · scored_by · translated_by`
- FR-LIN-2: In-pool subgraph for in-pool edges; synchronous query latency ≤ 50ms
- FR-LIN-3: **Cross-pool projection worker** (G8) — projects cross-pool edges asynchronously into Iceberg `warehouse.cross_pool_lineage` table within 5min
- FR-LIN-4: "Show derivation chain for record X" resolves in-pool sync + cross-pool async; one view
- FR-LIN-5: Backfills lineage from existing audit events
- FR-LIN-6: New state-changes emit lineage edges alongside audit envelopes (every SDK gets a `lineage.emit` helper from sdk-lineage)
- FR-LIN-7: Powers AI auditability (agent recommendation → derivation chain), regulator-grade derivation proofs, data-quality triage

**Pool placement:** Per-pool subgraph in `lineage` schema; cross-pool projection in Iceberg.

**SKUs:** `lineage.edge.write` (cheap) · `lineage.chain.query` · `lineage.cross-pool.query` — mixed.

### 5.7 · `@projexlight/sdk-semantic` — the Enterprise Semantic Model Layer

**Owns (all 6 types):**
- FR-SEM-1: **SemanticObject** — typed instance of a domain concept (Patient, Property, Donation, Order) with attributes drawn from MDM and persona extensions
- FR-SEM-2: **SemanticRelation** — typed relationships beyond ReBAC (`treats · owns · funds · refers · derives_from`)
- FR-SEM-3: **CapabilityGraph** — which SDK methods are valid operations on which SemanticObject types; agents traverse to plan
- FR-SEM-4: **DomainOntology** — per-vertical ontology bundles registered to the platform (Healthcare · Realty · Seva ontologies as v1)
- FR-SEM-5: **SemanticIntent** — a typed goal (`goal: 'schedule_follow_up_visit', subject: Patient, parameters: {...}`); agents plan from Intents
- FR-SEM-6: **SemanticPolicy** — ontology-aware authz rules in IQL over SemanticObjects/Relations; compiles to ABAC + ReBAC
- FR-SEM-7: Cross-domain bridges (Patient in Healthcare ↔ Person in Realty)
- FR-SEM-8: Persona-extension data auto-registers as SemanticObjects so verticals plug in without rebuilding ontology
- FR-SEM-9: MCP-exposed tools auto-register in CapabilityGraph (from sdk-mcp-bridge in P6A)
- FR-SEM-10: Per-vertical SemanticObject extensions stay in App Pool; promoted to contracts via Rule of Three

**Public API surface:**
```ts
export async function defineObject(spec: SemanticObjectSpec): Promise<SemanticObjectRef>;
export async function registerOntology(bundle: DomainOntology): Promise<OntologyVersion>;
export async function plan(intent: SemanticIntent, ctx: AgentContext): Promise<Plan>;
export async function evaluate(policy: SemanticPolicy, ctx: AgentContext): Promise<PolicyDecision>;
```

**Pool placement:** Ontology bundles in `@projexlight/contracts` (v1) or Global Catalog (when too large); per-tenant SemanticObjects in App Pool.

**SKUs:** `semantic.intent.plan` · `semantic.policy.evaluate` · `semantic.ontology.register` — `tiered_per_call`.

### 5.8 · `@projexlight/connector-snowflake`

**Owns:**
- FR-CSN-1: OAuth + Snowflake account connect
- FR-CSN-2: Bidirectional sync: ProjexCloud Iceberg lakehouse ↔ Snowflake tables (configurable per table)
- FR-CSN-3: Query federation: agents can query customer's Snowflake; results piped through capability tokens + meter
- FR-CSN-4: Tool manifest for agent CapabilityGraph: `snowflake.query` · `snowflake.table.read` · `snowflake.export.to-iceberg`

**SKUs:** `snowflake.query` (per-byte scanned · passthrough+margin) · `snowflake.sync.row` (per-row).

---

## 6 · Non-functional requirements

| Dimension | Target |
|---|---|
| RAG retrieval (policy-filtered) | ≤ 500ms p99 |
| Parsing 1-page document | ≤ 5s p99 (OCR + extraction) |
| Conversation message round-trip | ≤ 2s p99 (excluding LLM time) |
| Analytics rollup query (90d hot) | ≤ 5s p99 |
| Iceberg lakehouse query (TB-scale) | ≤ 30s p99 |
| Lineage cross-pool projection lag | ≤ 5min p99 |
| Semantic Intent → Plan latency | ≤ 1s p99 |
| Semantic Policy evaluation | ≤ 5ms p99 |
| Snowflake connector sync lag | ≤ 5min p99 (poll-driven; bidirectional CDC where available) |

---

## 7 · Acceptance criteria (the phase exit gate · matches §0A.4 P6B)

| # | Criterion | Owner | Test plan |
|---|---|---|---|
| **AC-1** | Parsing extracts a sample document via the 8-stage pipeline; lineage edges emitted | AI Platform | Integration test |
| **AC-2** | RAG retrieves with policy-filtered hits (only docs the persona may read) | AI Platform | Permission test |
| **AC-3** | Conversation message round-trip with sandboxed memory (no cross-tenant leak) | AI Platform | Integration test |
| **AC-4** | Analytics aggregates cross-pool via warehouse only (no live cross-pool joins); Iceberg extracts queryable | Data Platform | Integration test |
| **AC-5** | **Lineage cross-pool projection populated within 5min of source change** (G8) | Data Platform | End-to-end lineage test |
| **AC-6** | "Show derivation chain" surfaces every transformation across pools | Data Platform | Lineage query test |
| **AC-7** | **Semantic** — Healthcare + Realty + Seva ontologies v1 loaded | Verticals + Platform | Ontology registration test |
| **AC-8** | **Agent given an Intent walks Intent → CapabilityGraph → Action** to produce a valid multi-step plan without prompt-engineered exemplars (G9) | AI Platform | Agent planning test |
| **AC-9** | **SemanticPolicy enforces ontology-aware authz** (e.g., "Doctor with active care-team Relation to Patient may write Rx") | AI Platform + Identity | Policy evaluation test |
| **AC-10** | Cross-vertical inference test passes — patient + property → care-coordination flag | Verticals | End-to-end scenario |
| **AC-11** | **connector-snowflake**: customer connects Snowflake; agent queries customer's warehouse via capability token; bidirectional sync (one table) round-trips | Integrations | Snowflake sandbox |
| **AC-12** | Recommendation suggests next-best-action for a CRM lead using tenant-isolated model | AI Platform | Recommendation test |
| **AC-13** | All P6B SDKs published as v1.0.0 | Platform | `npm view` |

---

## 8 · Test plan (selected)

### AC-5 · Lineage cross-pool projection

**Scenario:**
- Time T: a document parsed in App Pool E (Evidence Pool) produces extracted fields in App Pool H (Healthcare Pool)
- Lineage edges: `extracted_from` (in-pool E) + `derived_from` (cross-pool E → H)
- Cross-pool projection worker emits the edge to Iceberg `cross_pool_lineage` table

**Pass condition:** At T+5min, query Iceberg → cross-pool edge present; "show derivation chain for the extracted field" returns both in-pool + cross-pool segments.

### AC-8 · Intent → Plan

**Scenario:**
- Healthcare ontology loaded; Patient persona `pers_ravi_hA_patient` exists
- Intent: `{goal: 'schedule_follow_up_visit', subject: {type: 'Patient', id: 'pers_ravi_hA_patient'}, parameters: {within_days: 14, prefer_morning: true}}`
- Agent (P6A runtime) calls `semantic.plan(intent)`

**Pass condition:** Returns a valid plan (e.g., `[check_calendar, create_encounter, notify_patient]`); each step is a valid tool from the CapabilityGraph; plan executable end-to-end.

### AC-9 · SemanticPolicy ontology-aware authz

**Scenario:**
- Policy: "A Doctor (Persona kind) with an active `care-team` Relation to a Patient may write a Prescription (SemanticObject) for that Patient"
- Dr. Smith has active care-team relation with Ravi → policy ALLOWS Rx write for Ravi
- Dr. Jones has no relation → policy DENIES Rx write for Ravi

**Pass condition:** Both decisions audited; correctness 100%.

### AC-11 · Snowflake connector

**Scenario:**
- Connect Snowflake sandbox account
- Configure one-table bidirectional sync (`customer_intel.product_usage`)
- Update one row in Snowflake → mirrors to Iceberg within 5min
- Update one row in Iceberg → mirrors to Snowflake within 5min
- Agent queries `snowflake.query('SELECT * FROM customer_intel.product_usage WHERE tenant_id = ?')` via mcp-bridge OR connector — gated by capability token + meter

**Pass condition:** All flows complete; no row loss; conflict policy applied if both sides update simultaneously.

---

## 9 · Dependencies

- ✅ P6A exit gate green (agent isolation is the safety prerequisite for everything P6B)
- ✅ sdk-trace running (lineage queries cross-reference trace_id)
- ✅ sdk-ai-gateway stable (RAG + parsing use it heavily)
- ✅ Iceberg infrastructure provisioned (S3 buckets + Iceberg catalog + Trino cluster)
- ✅ Vendor sandbox: Snowflake

---

## 10 · Out of scope (deferred to P7)

- ❌ Full pool federation runtime (only hooks in P1) — P7
- ❌ Hard meter caps (DENY) — P7
- ❌ Field/evidence/storm/dispatch SDKs — P7
- ❌ HDK measure + watermark — P7

---

## 11 · Risks

| # | Risk | Severity | Likelihood | Mitigation |
|---|---|---|---|---|
| R-1 | **Semantic Domain Layer over-fits to vertical 1** (likely Healthcare) | H | M | Rule of Three for ontology promotion to contracts; vertical-specific concepts stay in vertical ontologies; cross-vertical concepts (Person, Address, Money, Document) introduced first as universal core |
| R-2 | Iceberg lakehouse query performance degrades at scale | M | M | Partition by (region · tenant · time); Z-order on common predicates; cost monitoring per query |
| R-3 | Lineage projection lag exceeds 5min during ingest spikes | M | M | Back-pressure to ingest; multiple projection workers; sampled emission acceptable for non-regulated data |
| R-4 | RAG retrieval misses recently-uploaded docs (indexing lag) | L | M | Synchronous indexing for ≤10MB docs; async for larger; surface indexing status |
| R-5 | Parsing pipeline fails on edge-case document formats | M | H | Human review queue as fallback; per-tenant schema overrides |
| R-6 | Snowflake API costs balloon when agents query indiscriminately | M | M | Per-tenant Snowflake quota in Tenant Admin; agent SKU includes Snowflake bytes scanned |
| R-7 | Cross-vertical bridge in semantic layer creates unintended access paths (Patient in Healthcare → Person in Realty bridging exposes Realty data to Healthcare agent) | H | M | Bridges are read-only by default; cross-vertical access requires explicit cross-tenant relationship + consent |

---

## 12 · Rollout plan

1. **Week 40–41**: sdk-knowledge-rag + sdk-conversation (depend on P6A agent runtime)
2. **Week 40–42**: sdk-analytics (Iceberg layer ramp)
3. **Week 40–42**: sdk-lineage (in-pool subgraph; projection worker)
4. **Week 40–44**: sdk-semantic — the long pole (6w XL); ontology registry first, then Intent + Policy
5. **Week 40–42**: sdk-parsing (7w); long pole within P6B
6. **Week 41–42**: sdk-recommendation
7. **Week 41–43**: connector-snowflake
8. **Week 43**: Cross-vertical inference scenario test
9. **Week 44**: Phase exit-gate review

---

## 13 · Open questions / decisions needed

- [ ] Q-1: Ontology bundle format — JSON-LD vs custom typed schema? Recommend custom typed schema in TS with JSON-LD export for interop
- [ ] Q-2: SemanticIntent vocabulary — controlled vocabulary vs free-form text + LLM normalization? Recommend hybrid (controlled for top-200 goals; LLM normalization for tail)
- [ ] Q-3: Lineage projection — strict consistency (block until projected) vs eventual (≤5min lag)? Recommend eventual; flag in trace UI when querying recently-changed data
- [ ] Q-4: Iceberg catalog — Hive Metastore vs AWS Glue vs Project Nessie? Recommend Glue for AWS deployments, Nessie for multi-cloud
- [ ] Q-5: First three ontology bundles (Healthcare · Realty · Seva) — finalize scope before week 40

---

## 14 · Sign-off

| Role | Name | Date | Status |
|---|---|---|---|
| Phase DRI | AI Platform + Data Platform Leads | | |
| Platform Architect | Tanveer | | |
| Vertical Owners (Healthcare, Realty, Seva) | | | |
| Identity Working Group (for SemanticPolicy) | | | |
