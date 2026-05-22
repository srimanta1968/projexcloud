# PRD · P1 — Foundation Spine + Doctrines

| Field | Value |
|---|---|
| **Phase** | P1 |
| **Window** | Weeks 1–9 (~9 weeks) |
| **Maps to wave(s)** | W0 (Foundations) + W1 (Compliance + Pool + Meter) |
| **Gates closed** | G1 (doctrines) · G2 (Polyglot Persistence) · G3 (Event Type Registry enforced) |
| **Status** | DRAFT |
| **Owner (DRI)** | Platform Architect (Tanveer) |
| **Companion docs** | `../docs/v3.1/Architecture-v3.1.html` §3A · §3B · §8B · `../docs/v3.1/SDK-Build-Plan-v3.1.html` §W0 · §W1 |

---

## 1 · TL;DR

P1 lays the **substrate** every later phase depends on: typed contracts with the event taxonomy registry, a 7-tier vault key hierarchy with cryptographic-shred, an append-only audit chain, the pool router that resolves `(tenant_id, app_id) → dsn`, and the universal meter gate (emit-only mode). Three architectural doctrines are published and CI-enforced from week 1: **Opinionated Constraints**, **Localize Complexity**, and **Polyglot Persistence**. Without P1, every later SDK reinvents encryption, audit, routing, and metering — recovery is impossible.

---

## 2 · Why this phase now

Compliance is structural. Pool routing is structural. Pay-as-you-use metering is structural. If we ship P2 (Identity & Access) before Vault exists, identity data goes into unencrypted columns "temporarily" and the cryptographic-shred guarantee is non-recoverable. If we ship without Pool Router, every later SDK invents its own routing shim — ripping them out later is a 6+ week refactor across 30+ SDKs. If we ship without Meter, P2–P7 traffic is unbillable and the pricing catalog cannot be validated against real load.

The three doctrines (G1 + G2) close the meta-issue both architectural reviews flagged: without **Opinionated Constraints**, every team pulls things into common and the platform becomes a product of its own; without **Polyglot Persistence**, teams misplace telemetry/vectors/lineage into Postgres pools and hit ceilings.

---

## 3 · What ships in this phase

| Component | Type | Effort | Owner | Notes |
|---|---|---|---|---|
| `@projexlight/contracts` | Foundation pkg · NEW | M · 3w | Platform Architect | Scope hierarchy types · canonical IDs · six identity types · pool-routing types · event envelope · `UsageEvent.v1` · `PricingSKU/Catalog` · `@meter` decorator schema · `EventTypeRegistry` · `IQLGrammar` · `SemanticObject/Relation/CapabilityGraph/Ontology/Intent/Policy` stubs · `AgentIdentity` · `ConflictPolicy` · extended hierarchy types (Reseller · parent_tenant_id · parent_bu_id · GeographicNode · RoleTemplate · FiscalPeriod) |
| `@projexlight/config` | Foundation pkg · NEW | S · 1w | Platform | Typed env loader · tenant-scoped overrides · vault secret refs |
| `@projexlight/telemetry` | Foundation pkg · NEW | S · 1.5w | Platform | OTel wiring · Langfuse helpers · envelope-context propagation |
| `@projexlight/i18n` | Foundation pkg · NEW | S · 1w | Frontend | Locale-bundle loader · ICU messages · per-tenant fallback |
| `@projexlight/design-system` | Foundation pkg · NEW | M · 3w | Frontend Lead | React + RN primitives via `react-native-web` |
| `@projexlight/branding` | Foundation pkg · NEW | S · 1w | Frontend | Per-tenant theming layer |
| Workspace tooling | Repo infra · NEW | M · 2w | Platform Architect | pnpm workspaces · turbo · CI (contracts diff · cross-consumer contract test · semver) |
| `@projexlight/sdk-secrets` | SDK · NEW | M · 2w | Platform | Typed KMS facade (AWS KMS · GCP KMS · HSM) · secret refs · envelope helpers |
| `@projexlight/sdk-vault` | SDK · NEW | L · 6w | Platform | 7-tier envelope key hierarchy (root · app · pool · tenant · person · device · encounter) · issue/rotate/shred · per-encounter keys · cryptographic-shred = right-to-erasure |
| `@projexlight/sdk-audit` | SDK · NEW | M · 4w | Platform | Append-only ledger · tamper-evident hash chain · per-pool chain + regional rollup · `EventTypeRegistry` enforcement · retention classes · compaction policy · customer-read API |
| `@projexlight/sdk-pool-router` | SDK · NEW | L · 5w | Platform | Pool Registry · `(tenant_id, app_id) → dsn` resolver · `withTenant(...)` helper · pool lifecycle state machine · federation hooks (runtime delivered P7) |
| `@projexlight/sdk-meter` | SDK · NEW | L · 4w | Platform | Two-phase gate (check + report); emit-only mode in P1 — gate never denies, events flow; meter-codegen middleware wraps every `@meter` annotated method; hash-chained `(tenant, day)` usage ledger linking into Audit |
| **Architecture §3A** Opinionated Constraints | Doctrine · NEW | — | Platform Architect | 10 lint-enforced rules (OC-1..OC-10) — applied from week 1 |
| **Architecture §3B** Localize Complexity | Doctrine · NEW | — | Platform Architect | Global vs Local table (11 concepts) + 4 tests for deciding |
| **Architecture §8B** Polyglot Persistence | Doctrine · NEW | — | Platform Architect | Workload→storage table (12 workloads) + 6 rules; "Postgres pools are for OLTP + PII only" |
| **CI doctrine enforcement** | Tooling · NEW | M · 2w | Platform | `tools/lint-rules/` package implementing OC-1..OC-10 + cross-pool sanction checker + Event Type Registry validator |
| `services/identity-projector` | Service stub | S · 1w | Platform | Placeholder for the projector worker that fills in P2 — schema reserved in `subject_view` projection table |
| `services/meter-collector` | Service · NEW | M · 3w | Platform | Kafka consumer → ClickHouse rollup writer (shared cluster partitioned by `pool_index`) |

---

## 4 · User stories

### As a **Platform Engineer**
- **US-PE-1**: I import `@projexlight/contracts` in any package and get type-safe access to every shared primitive (scope hierarchy, identity types, pool routing, event envelope, metering types) — no copy-paste between packages.
- **US-PE-2**: I annotate a public method with `@meter('identity.jwt.mint', 'call', 'core')` and codegen wraps it with the two-phase gate at build time — I never write metering boilerplate.
- **US-PE-3**: I call `withTenant({tenantId, appId}, async (db) => …)` and the router resolves the pool DSN; I cannot accidentally cross-pool query because the linter blocks raw clients.
- **US-PE-4**: When I open a PR that violates a doctrine (e.g., emitting an unregistered event), CI tells me which rule (OC-2) and links to Architecture §3A.

### As a **ProjexCloud Operator**
- **US-OP-1**: I run the nightly audit hash-chain verification job and get a green result; any tampering surfaces as a chain-break alert with the offending pool + range.
- **US-OP-2**: I shred a `person_key` in a chaos drill and every record referencing that person becomes undecryptable; auditor-grade proof of right-to-erasure.
- **US-OP-3**: I see meter events flowing into ClickHouse within 60 seconds of the originating SDK call (emit-only mode); rollups match raw counts byte-perfect.

### As a **Security / Compliance Lead**
- **US-SC-1**: I verify that shredding a `pool_kek` renders the entire pool's data undecryptable — and only that pool.
- **US-SC-2**: I verify the audit chain is per-pool with a regional roll-up; every state-changing operation in every P1 SDK writes one audit entry.

### As a **Finance Engineer** (preparing for P4 Billing)
- **US-FE-1**: I see usage events being emitted with full six-layer dimensions (org · app · tenant · bu · persona · encounter) even though no invoicing is happening yet — this validates the catalog design against real traffic shape before P4.

---

## 5 · Functional requirements (per SDK / component)

### 5.1 · `@projexlight/contracts`

**Purpose:** The single typed source of truth for every shared primitive.

**Owns:**
- FR-CTR-1: Scope-hierarchy types — `org_id · app_id · tenant_id · bu_id` + `parent_org_id · parent_tenant_id · parent_bu_id` for recursion
- FR-CTR-2: Canonical ID types — `person_id · address_id · device_uuid · reseller_id · geo_node_id · role_template_id · fiscal_period_id`
- FR-CTR-3: Six identity types — `AppIdentity · TenantMembership · Persona · Encounter · Relationship · RelationshipGrant`
- FR-CTR-4: Pool routing types — `PoolIndex · PoolFamily · TenantPoolMap · PoolFederationManifest`
- FR-CTR-5: Event envelope (the canonical wrapper) — see §19.1 of Architecture doc
- FR-CTR-6: Metering types — `UsageEvent.v1 · MeterDimensions · PricingSKU · PricingMode · PricingCatalog.vN · QuotaPolicy` + `@meter` decorator metadata schema
- FR-CTR-7: `EventTypeRegistry` — every event type registered with retention class (transient/operational/regulated) + compaction policy + schema-lifecycle state (active/deprecated/retired)
- FR-CTR-8: Forward-looking stubs for IQL, Semantic, Agent Identity, ConflictPolicy, ReBACTraversalBudget — concrete types ship in later phases but the namespaces are reserved here
- FR-CTR-9: Zod-validated schemas for every type; cross-package type imports compile cleanly

**Database / storage:** N/A (pure types). EventTypeRegistry serialized as typed const in source.

**Pool placement:** N/A (foundation package; consumed everywhere).

**SKUs (pricing surface):** None — internal package.

### 5.2 · `@projexlight/sdk-secrets`

**Purpose:** Typed KMS facade so no other SDK calls KMS directly.

**Owns:**
- FR-SEC-1: Abstract over AWS KMS · GCP KMS · HSM (via PKCS#11) — provider chosen at deploy time
- FR-SEC-2: Secret references of form `secret://app/<id>` resolved at runtime
- FR-SEC-3: Envelope encryption helpers (`encrypt` / `decrypt` with referenced KEK)
- FR-SEC-4: Key rotation primitives (rotate without re-encrypting leaf data)
- FR-SEC-5: Audit emit on every key operation (composes with sdk-audit once it exists)

**Pool placement:** KMS-backed (key material never in Postgres); refs may appear in any pool.

**SKUs:** None — internal infrastructure SDK.

### 5.3 · `@projexlight/sdk-vault`

**Purpose:** The 7-tier envelope key hierarchy that makes cryptographic-shred = right-to-erasure.

**Owns:**
- FR-VLT-1: Seven key tiers: `root · app · pool · tenant · person · device · encounter`
- FR-VLT-2: Issue / rotate / shred operations per tier (auth'd, audited)
- FR-VLT-3: Per-tier KEK storage in KMS (via sdk-secrets)
- FR-VLT-4: Open-encounter / close-encounter API issuing per-encounter keys; key shreds at encounter seal
- FR-VLT-5: Pool KEK wraps tenant keys held in pool; pool KEK shred renders pool data undecryptable
- FR-VLT-6: Cryptographic-shred chaos tests (Person · Encounter · Pool KEK) included in package

**Database / storage:** `vault` schema in Admin Pool — key metadata only (NEVER key material).

**Events published:**
- `vault.key.issued.v1` · `vault.key.rotated.v1` · `vault.key.shredded.v1` — retention: regulated · conflict: event-sourcing

**Pool placement:** Per-pool key tier (Pool KEK lives at pool level; downstream tiers below it).

**SKUs (pricing surface):** `vault.key.issue` · `vault.key.rotate` · `vault.key.shred` · `vault.encrypt` · `vault.decrypt` — pricing mode: `flat_per_call` (low rate; these are infrastructural).

### 5.4 · `@projexlight/sdk-audit`

**Purpose:** The append-only ledger that proves every state-changing operation.

**Owns:**
- FR-AUD-1: Append-only per-pool ledger with content-addressed entries
- FR-AUD-2: Tamper-evident hash chain; nightly verifier job runs across all pools
- FR-AUD-3: Per-tenant retention rules with cryptographic-shred at expiry (composes with Vault)
- FR-AUD-4: Customer-facing read API — tenant pulls their own audit log for SOC2/HIPAA self-audits; signed PDF + JSONL export
- FR-AUD-5: `EventTypeRegistry` enforcement — unregistered event types rejected at the producer with a clear error
- FR-AUD-6: Per-event-type retention class enforcement (transient · operational · regulated)
- FR-AUD-7: Topic compaction policy for high-cardinality topics (LWW · count · none)
- FR-AUD-8: Regional roll-up of per-pool audit chains for cross-region attestation

**Database / storage:** `audit` schema in every pool (append-only) + S3 for long-term archival.

**Events published:** Implicitly emits about its own operations (chain verifications, exports).

**Pool placement:** Per-pool audit chain (in every pool).

**SKUs (pricing surface):** `audit.write` (per-event; usually bundled in the SDK that wrote it) · `audit.export.pdf` · `audit.export.jsonl` — `flat_per_call`.

### 5.5 · `@projexlight/sdk-pool-router`

**Purpose:** Resolve `(tenant_id, app_id) → pool_index → dsn` in <5ms.

**Owns:**
- FR-PR-1: Pool Registry in Admin Pool with Redis cache layer
- FR-PR-2: `withTenant({tenantId, appId, role}, async (db) => …)` helper consumed by every later SDK
- FR-PR-3: Pool lifecycle state machine (ACTIVE · MIGRATING · QUARANTINED · RETIRED)
- FR-PR-4: Cache invalidation on pool state flip fans out across services within 1s
- FR-PR-5: Routing latency telemetry per call (emits to sdk-telemetry)
- FR-PR-6: Cross-pool query attempts fail at lint (the `@cross_pool_sanctioned` decorator enables the four sanctioned exceptions: resolver two-pool fetch · DSAR fan-out · analytics warehouse · lineage projection)
- FR-PR-7: `PoolFederationManifest` schema + hook points (full federation runtime delivered P7)

**Database / storage:** `routing` schema in Admin Pool of each region; Redis per region for the cache.

**Events published:** `tenant.pool.assigned.v1` · `pool.lifecycle.changed.v1`.

**Pool placement:** Pool Registry in Admin Pool of region; routing decisions stateless.

**SKUs (pricing surface):** N/A (infrastructure — its cost rolls up implicitly).

### 5.6 · `@projexlight/sdk-meter`

**Purpose:** The universal two-phase gate every SDK call passes through.

**Owns:**
- FR-MET-1: Phase 1 admission gate `check()` — sync, p99 ≤ 2ms, returns ALLOW / WARN / DENY from Redis quota state
- FR-MET-2: Phase 2 emission `report()` — async, fire-and-forget, emits `usage.event.v1` to Kafka partitioned by `tenant_id`
- FR-MET-3: Per-pool stream processor → ClickHouse rollups (shared cluster partitioned by `pool_index`)
- FR-MET-4: Hash-chained `(tenant, day)` usage ledger linking into Audit (for customer-verifiable `/billing/verify`)
- FR-MET-5: Live counter in Redis powers customer real-time meter (≤60s lag, exposed in P4 via `/billing/live`)
- FR-MET-6: `@meter` decorator codegen — every annotated method gets wrapper without per-SDK code
- FR-MET-7: **Day-one mode is emit-only** — gate ALLOWs everything; soft caps enable in P4; hard caps in P7
- FR-MET-8: Pricing catalog lookup helper (catalog content lives in `@projexlight/contracts`)

**Database / storage:** `meter` schema in Admin Pool (quota state) + Kafka `usage.events.v1` topic + shared ClickHouse cluster (rollups) + Redis (live counter + quota cache).

**Events published:** `usage.event.v1` (the primary output) · `usage.softcap.warn.v1` (P4 onward) · `usage.hardcap.exceeded.v1` (P7 onward).

**Pool placement:** Events in Kafka; rollups in shared Warehouse ClickHouse (NOT per-pool); per-call quota cache in Redis.

**SKUs (pricing surface):** N/A — it's the gate itself; platform-internal.

### 5.7 · Architecture §3A Opinionated Constraints (doctrine)

**Owns:**
- FR-OC-1: Publish §3A in Architecture-v3.1.html with 10 lint-enforced rules (OC-1..OC-10)
- FR-OC-2: Implement each rule in `tools/lint-rules/` as a custom ESLint plugin
- FR-OC-3: CI runs the lint suite on every PR; any violation fails the build with a link to the rule
- FR-OC-4: New rules require Working Group RFC + sign-off

### 5.8 · Architecture §3B Localize Complexity (doctrine)

**Owns:**
- FR-LC-1: Publish §3B with the global-vs-local table (11 concepts) + 4 tests for deciding
- FR-LC-2: Architectural design reviews use the 4 tests to classify any new concept

### 5.9 · Architecture §8B Polyglot Persistence (doctrine)

**Owns:**
- FR-PP-1: Publish §8B with workload→storage map (12 workloads) + 6 rules
- FR-PP-2: CI rule (OC-3 / §8B) blocks raw Postgres clients outside `withTenant`; lakehouse/ClickHouse/OpenSearch/Kafka/Redis/Vector usage governed by SDK packaging

---

## 6 · Non-functional requirements

| Dimension | Target |
|---|---|
| Meter gate latency (p99) | ≤ 2ms warm; ≤ 10ms cold |
| Pool router resolve (p99) | ≤ 5ms warm; ≤ 20ms cold |
| Meter event end-to-end (call → ClickHouse) | ≤ 60s |
| Audit write rate per pool | 50k events/sec sustained |
| Audit verify job | nightly; chain-break alert in ≤ 5min |
| Vault key operation latency | shred ≤ 50ms; encrypt/decrypt ≤ 5ms |
| Availability (each P1 SDK) | 99.95% within the pool |
| Compliance | GDPR · DPDP · HIPAA-ready · SOC2 audit trail |
| Cost guardrail | Meter overhead ≤ 0.5% of total request CPU |

---

## 7 · Acceptance criteria (the phase exit gate)

These match `SDK-Build-Plan-v3.1.html §0A.4` for P1.

| # | Criterion | Owner | Test plan |
|---|---|---|---|
| **AC-1** | Vault chaos: shred a `person_key` → every record referencing that person is undecryptable across all pools | Platform | Chaos drill — see §8 AC-1 |
| **AC-2** | Vault chaos: shred an `encounter_key` → only that encounter's payload undecryptable; nothing else affected | Platform | Chaos drill — see §8 AC-2 |
| **AC-3** | Vault chaos: shred a `pool_kek` → that pool's data undecryptable; other pools unaffected | Platform | Chaos drill — see §8 AC-3 |
| **AC-4** | Audit hash-chain verify-job runs nightly across all pools; tamper-injection surfaces a chain-break alert ≤ 5min | Platform | Tamper-injection drill |
| **AC-5** | Pool Router resolves a test tenant pinned to `app-healthcare-007` in p99 ≤ 5ms warm, ≤ 20ms cold | Platform | Load test |
| **AC-6** | Pool state flip from ACTIVE→MIGRATING fans out cache invalidation across all services within 1s | Platform | Chaos drill |
| **AC-7** | Cross-pool query attempt without `@cross_pool_sanctioned` fails at lint | Platform | CI rule test |
| **AC-8** | Meter admission gate p99 ≤ 2ms warm | Platform | Load test (10k req/s synthetic) |
| **AC-9** | 10k synthetic SDK calls produce 10k `usage.event.v1` records with zero loss (at-least-once + idempotent `event_id`) | Platform | Synthetic load test |
| **AC-10** | Daily ClickHouse rollup matches raw event count to byte-perfect parity | Platform | Reconciliation job |
| **AC-11** | Usage hash-chain verify-job catches injected tampering in the `(tenant, day)` ledger | Platform | Tamper-injection drill |
| **AC-12** | `@meter` codegen wraps every annotated method in every P1 SDK with no per-SDK boilerplate | Platform | CI inspection of generated code |
| **AC-13** | Opinionated Constraints doctrine published (§3A); 10 lint rules (OC-1..OC-10) active in CI; sample violations fail PRs with link to rule | Platform Architect | CI lint suite passes a known-good repo and fails 10 known-bad PRs |
| **AC-14** | Localize Complexity doctrine published (§3B); design-review checklist updated | Platform Architect | Doc published + working group sign-off |
| **AC-15** | Polyglot Persistence doctrine published (§8B); CI rule blocks raw Postgres clients outside `withTenant` | Platform Architect | CI fails a synthetic PR introducing a raw `pg.Client` |
| **AC-16** | EventTypeRegistry enforced: producer rejects unregistered event types at runtime with clear error message | Platform | Synthetic producer attempting `foo.bar.v1` (not in registry) fails closed |
| **AC-17** | All foundation packages (contracts, config, telemetry, i18n, design-system, branding) published to private registry as v1.0.0 | Platform | `npm view @projexlight/contracts version` returns `1.0.0` |
| **AC-18** | Sample app boots locally consuming all P1 packages — full envelope context propagates across services via telemetry | Platform | Manual smoke test |

---

## 8 · Test plan (per acceptance criterion)

### AC-1 · Person key shred renders person's data undecryptable

**Scenario:**
- Given a test tenant `ten_test_001` with a registered `person_id pers_alice` and data in 3 pools (admin, app-healthcare, app-realty)
- When the chaos drill invokes `sdk-vault.shred({tier: 'person', subject_id: 'pers_alice'})`
- Then every read of any record referencing `pers_alice` across all 3 pools returns `UndecryptableError` within 30 seconds (cache invalidation)
- And the shred operation is recorded in `sdk-audit` with the operator, timestamp, and chain link

**Test type:** Chaos drill

**Environment:** Staging with 3 test pools and 10k synthetic person records

**Pass condition:** 100% of records referencing `pers_alice` undecryptable; 0% of records referencing other persons affected; audit chain entry verified

**Evidence:** Chaos drill report with timestamps, audit chain entry hash, query results before/after

### AC-2 · Encounter key shred is scoped

**Scenario:** Open encounter `enc_visit_001`; write payload; close + seal encounter; trigger encounter-key shred. Verify only that encounter's payload is undecryptable; sibling encounters of the same persona still decryptable.

**Test type:** Chaos drill · Pass condition: scoped to one encounter

### AC-3 · Pool KEK shred is scoped to the pool

**Scenario:** Shred `pool_kek` for `app-healthcare-007`; verify that pool's data undecryptable; `app-healthcare-008` and `app-realty-003` unaffected.

### AC-5 · Pool Router latency

**Scenario:** Load test with 10 concurrent clients each issuing 1000 resolves of `(ten_test_001, healthcare)` over 60s.

**Test type:** k6 load test

**Pass condition:** p99 ≤ 5ms warm cache hits; ≤ 20ms cold (post-cache-flush)

### AC-8 + AC-9 · Meter gate + emission

**Scenario:** Synthetic SDK with one `@meter` method; 10k calls over 30s from 10 concurrent clients.

**Pass condition:** Gate p99 ≤ 2ms; 10k events visible in ClickHouse rollup within 60s; event_id deduplication verified by re-running last 100 calls (rollup count unchanged).

### AC-13 · Doctrine enforcement

**Scenario:** Open a PR that (a) writes a raw `pg.Client`, (b) emits an unregistered event type, (c) imports `sdk-identity` from a non-resolver SDK.

**Pass condition:** Each violation fails CI with the rule ID (OC-3, OC-2, OC-4) and a link to the doctrine section.

### AC-16 · EventTypeRegistry enforcement

**Scenario:** Producer attempts to publish event of type `foo.bar.v1` not registered in `@projexlight/contracts`.

**Pass condition:** Producer side throws `UnregisteredEventTypeError` with the registry's allowed namespaces in the error message; nothing reaches Kafka.

(AC-4, AC-6, AC-7, AC-10, AC-11, AC-12, AC-14, AC-15, AC-17, AC-18 follow analogous Given/When/Then structures — captured in the engineering ticket per AC.)

---

## 9 · Dependencies (what must be true entering this phase)

- ✅ Repos created: `projex-platform/` monorepo bootstrapped
- ✅ Private npm registry (`npm.projexcloud.com`) operational
- ✅ Kubernetes clusters provisioned in primary dev region
- ✅ Cloud KMS accounts (AWS KMS · GCP KMS) accessible from the cluster
- ✅ Kafka cluster operational in dev region
- ✅ ClickHouse cluster operational in dev region (shared, partitioned by `pool_index`)
- ✅ Redis cluster operational in dev region
- ✅ Postgres provisioning automation (we can spin up new pool clusters via Terraform in <30min)
- ✅ Working Group signed off on the §3A, §3B, §8B doctrines

---

## 10 · Out of scope (deferred to later phases)

- ❌ JWT minting and identity tables — P2
- ❌ Persona, Profile, Geo, Device, Resolver — P3
- ❌ Hard meter caps (DENY mode) — P7 (emit-only in P1, soft caps in P4)
- ❌ Billing & invoicing — P4
- ❌ HDK modules — P3
- ❌ Pool federation runtime (only hooks ship in P1) — P7
- ❌ Iceberg lakehouse — P7
- ❌ AI Gateway / Agent Runtime — P6A
- ❌ Connectors framework / MCP — P4 / P6A

---

## 11 · Risks

| # | Risk | Severity | Likelihood | Mitigation |
|---|---|---|---|---|
| R-1 | Meter gate latency budget (≤2ms) regresses under load | H | M | Lint rule fails any PR that adds work to the gate hot path; per-PR microbenchmark; CI tracks p99 over time |
| R-2 | "Just stub it" pressure on Vault before chaos tests pass | H | H | CI fails any PR that imports `sdk-profile` (P3) while `sdk-vault` is below v1.0; gates ship before consumers |
| R-3 | Doctrine push-back from teams ("we need flexibility") | H | H | Working Group sign-off required for any exception; pre-publish socialization with all team leads in week 2 |
| R-4 | EventTypeRegistry becomes a bottleneck (every event change requires a contracts PR) | M | M | Self-service event-type registration tool in `tools/`; contracts PRs auto-merge if they only add (never modify or remove) entries |
| R-5 | Pool router cold-cache latency exceeds 20ms under contention | M | M | Pre-warm cache on service start; Redis cluster sized for working set |
| R-6 | Kafka cardinality explodes from telemetry events | M | L | Event Type Registry retention classes enforce compaction; telemetry events default to LWW |
| R-7 | Vault chaos drills cause real data loss in staging | L | L | Drills run only against synthetic data; chaos pod isolated; recovery procedure documented and rehearsed |

---

## 12 · Rollout plan

1. **Week 1–3**: Contracts + Foundation packages (config, telemetry, i18n, design-system, branding) → published as v0.x to private registry; iterating
2. **Week 2**: Doctrines (§3A, §3B, §8B) published in Architecture doc; Working Group review week 2 end; sign-off week 3
3. **Week 3–4**: CI lint rules (OC-1..OC-10) implemented and merged; PR-blocking enabled
4. **Week 3–9**: sdk-secrets → sdk-vault track; sdk-audit track; sdk-pool-router track; sdk-meter track — running in parallel after week 3
5. **Week 7**: First chaos drill (Vault person-key shred) in staging
6. **Week 8**: Pool router load test; meter load test; audit verify-job activated nightly
7. **Week 9**: All P1 packages cut as v1.0.0 to private registry; Phase exit-gate review meeting; P2 unblocked

---

## 13 · Open questions / decisions needed

- [ ] Q-1: Which KMS provider is the default for dev/staging? (AWS KMS recommended for parity with most enterprise targets.) — Decision needed by week 1
- [ ] Q-2: Audit retention default per class — confirm 7y for regulated, 90d for operational, 7d for transient
- [ ] Q-3: Initial pool sizing — 1 admin pool + 1 healthcare app pool + 1 realty app pool for dev region; confirm
- [ ] Q-4: Meter gate fail-closed vs fail-open behavior on Redis unavailability — recommend fail-open (admit) with high-cardinality alert; confirm with security
- [ ] Q-5: Naming of the private registry — `npm.projexcloud.com` vs `registry.projexcloud.com` — finalize before publishing v1

---

## 14 · Sign-off

| Role | Name | Date | Status |
|---|---|---|---|
| Phase DRI | Tanveer (Platform Architect) | | |
| Security / Compliance | TBD | | |
| Engineering Lead | TBD | | |
| Identity Working Group | (sign-off only required for contracts §) | | |
