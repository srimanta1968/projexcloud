# ProjexCloud v3.1 — Implementation vs. Design & Insignia Capability Reality Report

**Prepared:** 2026-06-09
**Repo / branch reviewed:** `ProjexCloud` @ `p7/field-evidence-hyperscale`
**Author:** Engineering review (static code + design-doc analysis)

---

## 0. How to read this report

This report compares **three things** and tells you, capability by capability, **what is real and works, what is partial, and what will not work / cannot honestly be claimed yet**:

1. **ProjexCloud v3.1 *design*** — `docs/v3.1/Architecture-v3.1.html`, `TechStack`, `ProjectStructure`, `SDK-Build-Plan`, `AgenticIntegration`, `AIM-Identity-Model`, and the PRD set `docs/v3.1/prd/P1…P9.2 + Tenant-BYOK`.
2. **The RealMDM / "Reality Engine OS" + "Developer MDM" vision** — `docs/insignia/realmdm_reality_engine_os_courseware.html` and `docs/insignia/Developer MDM.html`.
3. **The Insignia Cybersecurity Capability Deck v1.2** — `docs/insignia/Insignia_Cybersecurity_Capability_Deck V1.2.pptx` (32 slides), whose **Technical Due-Diligence Addendum** (slides 24–31) describes the exact zero-trust / identity / lineage / AI-security / PAM patterns this report scores against.

> **Basis & limits of this assessment.** Verdicts below are from **static review** of source, DB migrations, exports and tests — *not* from running the full monorepo, executing the integration/chaos suites, or load-testing the stated SLOs. The working tree currently has **uncommitted changes** and the most recent commits are build/`tsc` fixes (`af90efd`, `23bfb35`, `16ab821`), so "implemented" means *code-complete and structurally sound per inspection*, not "verified green in CI." Where a claim depends on runtime behaviour or external credentials, it is flagged.

---

## 1. Executive summary

**The honest headline:** ProjexCloud is a **genuinely substantial platform** — roughly **48 of ~58 reviewed packages/services/apps are substantially implemented** with real Postgres migrations, hash-chained ledgers, working services (150–450 LOC each), and three real Next.js operator/tenant apps. It is **not** vapourware or scaffolding.

**But** the Insignia deck and the RealMDM courseware describe the architecture in **named-vendor, zero-trust-mesh terms** (SPIFFE/SPIRE, Envoy PEP, Cilium, OPA/Cedar, OpenLineage, OCSF/Merkle, Temporal, Neo4j) that ProjexCloud **mostly does *not* use literally**. ProjexCloud implements the *same control objectives* with **application-layer equivalents** (JWT 6-layer claims, Postgres RLS + app-layer Pool Router, a custom IQL→Cedar-*shaped* evaluator, SHA-256 prev-hash audit chains, its own lineage graph). For an **outcome/control conversation** that is fine and defensible. For a **due-diligence buyer who reads slide 25 literally and asks "show me the SPIFFE SVIDs / the OPA bundle / the OpenLineage events"**, the answer is "we achieve that objective differently" — which must be said *before* the demo, not during it.

**Three things that will trip a literal reading of the deck:**

| Deck/courseware claim | Implementation reality | Verdict |
|---|---|---|
| Zero-trust **mTLS mesh** with **SPIFFE/SPIRE workload identity**, **Envoy PEP**, **Cilium** (slides 15, 25) | **Not present.** Service-to-service is JWT + API keys; tenant isolation is Postgres RLS + an app-layer Pool Router. Only mTLS use is outbound webhook client-certs (`sdk-webhook/mtlsAgent.ts`). | **Won't match a literal claim** — reframe as app-layer zero-trust. |
| **OPA / Cedar** policy engine (slides 16, 25, 28; RealMDM "OPA sidecar/bundle") | Custom **IQL parser → "Cedar-*shaped* term" → hand-rolled `evaluateCedar()`**. Intentionally Cedar-compatible *shape*; **not** the Cedar/OPA runtime. | **Partial** — real ABAC, not the named engine. |
| **OpenLineage** events + **OCSF** evidence ledger (slides 25, 26) | `sdk-lineage` uses its **own** node/edge model (no OpenLineage emitter found); `sdk-audit`/`sdk-meter`/`sdk-evidence` use **SHA-256 prev-hash chains** (tamper-evident hash chain, not a full Merkle tree, not OCSF schema). | **Partial** — equivalent integrity, non-standard format. |

**Connectors are demo-stubbed.** Slack, Salesforce, M365, GitHub etc. have correct tool *schemas*, audit events and graceful "not configured" degradation, but the actual third-party HTTP calls return `{ ok: true, stub: true }` and `sync()` returns `records_synced: 0` with "deferred" notes. **Do not demo a live external sync.**

---

## 2. The three source visions, in one paragraph each

- **ProjexCloud v3.1 (the build):** A multi-tenant, pool-isolated SaaS spine. Six-layer identity (Master Person → App Identity → Tenant Membership → Persona → Encounter → Relationship), ABAC+ReBAC, consent, a 7-tier crypto-shred vault, append-only audit, metering/billing, an AI gateway + agent-isolation runtime (capability tokens, execution TTL, deterministic replay, sandboxed per-tenant vector memory), RAG, semantic/ontology services, and an AI-native "build planner." Delivered in phases P1–P9.2; P7 (field/evidence/hyperscale) and P8 (deployment variants) are the current frontier.
- **RealMDM "Reality Engine OS" courseware + "Developer MDM":** A *doctrine-first* MDM control plane (Satya/Maya: pure entity vs. contextual role; "no Golden Record," relationships-as-contracts, event-sourced Reality Log, AI-as-observer-only, Cascading Cognition Grid SLM→LLM→Digital Jury). Prescribes **Go + gRPC + Temporal + Kafka + Neo4j + OPA + OpenLineage + SAS tokenization + crypto-shred ("Digital Ash")**. This is an **architecture/courseware/build-guide**, not the ProjexCloud codebase — ProjexCloud is a **conceptual cousin** built on a **different stack** (TypeScript/Postgres/Fastify, not Go/gRPC/Temporal/Neo4j).
- **Insignia Cybersecurity Capability Deck:** A **sales/capability deck** for security staff-aug → consulting pods. Its value to this comparison is the **due-diligence addendum**, which advertises reference patterns (zero-trust evidence fabric, telemetry/lineage/audit evidence model, AI-prompt-to-proof, MDM+ABAC+consent+DLP gate, PAM/vault). ProjexCloud is plausibly the **"sanitized internal architecture synthesis"** those slides are abstracted from.

---

## 3. Capability-by-capability scorecard (Insignia deck families → ProjexCloud)

Legend: **✅ Works** (implemented, demoable per static review) · **🟡 Partial** (works with caveats / scaffolded / deferred) · **🔴 Gap** (claimed in deck/design, not implemented / won't match literal claim).

### 3.1 Zero-Trust / workload identity / policy enforcement (deck slides 15, 25)
| Element | Status | Notes |
|---|---|---|
| Identity-bound access, default-deny, per-request authz | ✅ | JWT 6-layer claims; every read via `resolveIdentityContext()`; lint bans direct identity imports. |
| Tenant isolation / lateral-movement reduction | ✅ | Postgres RLS per tenant + app-layer **Pool Router**; cross-pool reads lint-banned except 4 sanctioned patterns. `sdk-pool-router` is A-tier (route cache, Redis broadcast, active-active). |
| **SPIFFE/SPIRE workload identity, mTLS service mesh, Envoy PEP, Cilium** | 🔴 | **Not implemented.** No mesh, no SVIDs, no Envoy/Cilium. Achieved-differently (JWT/API-keys/RLS). The slide-25 diagram has **no 1:1 code counterpart**. |
| OPA/Cedar PDP | 🟡 | `sdk-policy`: real IQL→Cedar-*shaped* evaluator; **not** OPA/Cedar runtime (see §3.2). |

### 3.2 IAM / ABAC / ReBAC + MDM golden record + Consent (deck slide 16; RealMDM core)
| Element | Status | Notes |
|---|---|---|
| OIDC/SAML/SCIM federation, MFA, sessions, impersonation | ✅ | `sdk-identity` A-tier (2 migrations, SAML adapter, federation, credential/alias hashing). |
| ABAC engine | ✅/🟡 | Real attribute-based eval with versioned precompiled bundles; engine is **custom (IQL→Cedar-shape)**, not OPA/Cedar. Control objective met; named engine not used. |
| ReBAC (relationship graph, bounded traversal) | ✅ | `sdk-rebac` A-tier: BFS traversal, depth/visit budget, reachability cache, cross-tenant edges. |
| **MDM "golden record" / identity resolution** | ✅ (ProjexCloud model) / 🟡 (vs RealMDM) | `sdk-identity-resolver` resolves a flattened identity context across the 6-layer MDM tables with hot/cold projection + live fallback. **But** this is ProjexCloud's *deterministic* canonical-ID model — it does **not** implement RealMDM's **probabilistic/graph/AI-jury entity resolution, calibration (ECE<0.05), or claims-not-merges** doctrine. If a buyer expects *RealMDM-style fuzzy resolution*, that is a **gap**. |
| Consent / purpose-of-use + cross-border | ✅ | `sdk-consent` A-tier: purpose registry, grant/revoke, cross-border check, receipts. |
| Identity projection (sub-ms reads) | ✅ | `sdk-projection` + `identity-projector` service: event-driven + TTL refresh, Redis mirror. (SLO p99≤0.5ms is **stated, not load-verified here**.) |

### 3.3 AI security & agentic governance (deck slides 18, 27)
| Element | Status | Notes |
|---|---|---|
| Agent isolation: capability tokens, execution TTL, deterministic replay, sandboxed memory | ✅ | `sdk-agent-runtime` A-tier — all four primitives present with HMAC-signed tokens, TTL enforcer, content-addressed replay, per-tenant vector-namespace isolation + cross-tenant leakage CI test. **Strongest match to the deck.** |
| Multi-provider AI gateway + PII redaction + per-tenant routing/budget | ✅ | `sdk-ai-gateway` A-tier (OpenAI/Anthropic/Bedrock/Gemini adapters, circuit breaker, Langfuse). |
| RAG with policy-filtered retrieval, per-tenant corpora | ✅ | `sdk-knowledge-rag` A-tier (pgvector, per-tenant namespace, policy overlay at retrieval). |
| Tenant BYOK AI keys (vaulted, rotate/revoke, audited) | ✅ | Implemented per Tenant-BYOK PRD; admin UI write-only. |
| Prompt registry / RAG-corpus *classification* / AI-DLP / eval-drift gates | 🟡/🔴 | Tool allowlists + metering + audit exist. A **formal prompt registry, RAG-corpus sensitivity classification, AI-DLP egress scanning, and eval/drift harness** (deck slide 27 "eval/guardrail shadow+canary") are **largely design-level / not found as shipped services.** |
| MCP bridge (consume + expose MCP tools) | 🟡 | `sdk-mcp-bridge` partial — registration/invocation skeleton + audit wiring, transport/schema-validation **deferred (TK-3293/94/95)**. `registry-mcp` service itself is A-tier. |

### 3.4 Telemetry / lineage / audit evidence (deck slides 25, 26)
| Element | Status | Notes |
|---|---|---|
| Append-only tamper-evident audit ledger + nightly verify + customer export | ✅ | `sdk-audit` A-tier: SHA-256 prev-hash chain, retention classes, verifier, signed export. |
| Cross-system trace (one trace_id across identity/consent/routing/meter/lineage) | ✅ | `sdk-trace` A-tier (ClickHouse-backed timeline, signed export). |
| Metering ledger (zero-loss) | ✅ | `sdk-meter` + `meter-collector` A-tier (Kafka→ClickHouse+Postgres dual-write, hash-chained). |
| Field-level lineage / derivation chain | ✅ (own model) / 🟡 (vs deck) | `sdk-lineage` + `lineage-projector` A-tier (emit, BFS chain, cross-pool→Iceberg). |
| **OpenLineage event format** | 🔴 | **No OpenLineage emitter found.** Lineage uses a proprietary node/edge schema. Equivalent capability, **non-standard wire format**. |
| **OCSF event schema / Merkle-tree evidence root** | 🟡 | Integrity via **SHA-256 prev-hash chains** (a hash chain, *not* a Merkle tree; *not* OCSF-formatted). "Tamper-evident" ✅; "OCSF/Merkle" as literally drawn on slide 26 ❌. |
| `business_reason` / `consent_grant_id` / `policy_bundle_hash` on every event | 🟡 | Audit events carry actor/action/resource/tenant/trace; full slide-26 evidence-field set (`business_reason`, `policy_bundle_hash`, signed root) is **partially** present — verify field coverage before claiming. |

### 3.5 PAM / Vault / secrets / privileged operations (deck slide 17, 29)
| Element | Status | Notes |
|---|---|---|
| Multi-tier KMS-backed vault, key issue/rotate/**crypto-shred** | ✅ | `sdk-vault` A-tier (3 migrations, AWS/GCP/HSM providers, rotation scheduler, BYOK, SIEM forwarder). 7-tier key hierarchy + shred-as-erasure. |
| BYOK / CMEK (customer CMK wraps tenant key; revoke→undecryptable) | ✅ | Implemented (P8). |
| Scoped, time-bounded, consent-gated, loudly-audited **impersonation** | ✅ | Per PRD design + audit wiring (30-min TTL, certificate-of-action). |
| **PAM proper: JIT credential broker, break-glass workflow, privileged session capture (SSH/RDP/DB/K8s), CyberArk/Vault-class** | 🔴 | **Not a product feature.** `sdk-secrets` is an **in-process catalog + KMS wrapper with no persistence/rotation/versioning** (B-tier). The deck's PAM/POM capability (slide 17/29) is an **Insignia *consulting* capability**, not a ProjexCloud module. Do not present ProjexCloud as a PAM tool. |

### 3.6 Data protection / DLP / classification / data-rights (deck slides 13, 28)
| Element | Status | Notes |
|---|---|---|
| DSAR (access/erasure/rectification/etc.) + cross-pool fan-out + certificate | ✅ | `sdk-data-rights` A-tier (lifecycle, residency registry, reconciliation, cert issuance). |
| Per-field envelope encryption of sensitive bands (PAN/Aadhaar/SSN…) | ✅ | Vault + Profile per-field shred. |
| Evidence chain-of-custody capture (GPS/IMU/device/consent stamping) | 🟡 | `sdk-evidence` partial — capture intake + chain verifier shipped; **legal-export + retention-shredder are stubs (P7 deferred)**. |
| **Microsoft Purview / DLP tuning / sensitivity-label classification / insider-risk** | 🔴 | **Not in product** — this is an Insignia *services* capability (slide 13). ProjexCloud has no content-aware DLP scanner or Purview integration. |

---

## 4. What is implemented and works (A-tier — safe to demo, per static review)

**Identity / access / privacy spine (the crown jewels):** `sdk-identity`, `sdk-identity-resolver`, `sdk-rebac`, `sdk-policy`, `sdk-persona`, `sdk-tenant`, `sdk-tenant-lifecycle`, `sdk-consent`, `sdk-data-rights`, `sdk-projection`, `sdk-api-keys`.

**Crypto / evidence / metering:** `sdk-vault` (incl. BYOK), `sdk-audit`, `sdk-trace`, `sdk-lineage`, `sdk-meter`, `sdk-diagnostic-telemetry`.

**AI platform:** `sdk-ai-gateway`, `sdk-agent-runtime` (the four isolation primitives), `sdk-knowledge-rag`, `sdk-semantic` (ontology/intent/SemanticPolicy, deterministic — no LLM dependency in v1), `sdk-catalog-index`, `sdk-registry`, `sdk-capability`, `sdk-conversation`, `sdk-parsing`, `sdk-search`, `sdk-ingest`.

**Isolation / scale:** `sdk-pool-router` (active-active aware).

**Services:** `api-gateway` (wires 15+ SDK migration chains, Kafka/Redis/ClickHouse, BYOK, SIEM), `identity-projector`, `lineage-projector` (Iceberg via Nessie/Glue backends), `meter-collector`, `semantic-service`, `registry-mcp`, `pool-federation-runtime`.

**Apps (real Next.js, real pages calling the gateway):**
- `projexcloud-admin` — ~18 operator pages (tenants, pools, pricing, invoices, webhooks, approvals, audit, sovereign-regions, onprem-installs, active-active).
- `tenant-admin` — ~13 pages (billing, members, API keys, webhooks, approvals, connectors, consent, AI/MCP-servers, BYOK).
- `tenant-workspace` — ~15 pages incl. the **`/build` AI planner**: real semantic retrieval over the ~88-SDK catalog, vertical-pack classification (healthcare/finserv/publicSector/fieldService/revops), foundation-SDK auto-injection, dependency closure. **Caveat:** the planner's generation step needs a real LLM key (`anthropic`/`openai`); with none it falls back to `local`/keyword — demo with a key configured.

---

## 5. What is partial / scaffolded (B-tier — works with caveats; do not over-claim)

| Package | What's real | What's missing / deferred |
|---|---|---|
| `sdk-evidence` | Capture intake (259 LOC), chain verifier/appender, seal guard | **Legal-export generator + retention-shredder are stubs** (P7 follow-up) |
| `sdk-secrets` | KMS provider plumbing, in-memory catalog, envelope wrap/unwrap | **No persistence, no rotation, no versioning** — not a credential store of record |
| `sdk-mcp-bridge` | Registration/invocation skeleton + audit wiring | **Transport probe + schema validation deferred (TK-3293/94/95)** |
| `sdk-taxonomy` | Tables + lookup | **Activation endpoints deferred (TK-3292)** |
| `sdk-sovereign` | 1 migration + region-registry/attestation/leak-detector **stubs** | Real registry/bundle-apply/attestation-watcher deferred (Y-P8-5/6) |
| `sdk-onprem` | 1 migration + install/bundle/billing **stubs** | No K8s execution layer; deferred (Y-P8-8/9/10) |
| `sdk-storm` | Provider-chain interface (NOAA/DTN/WU) | **Real weather-API HTTP calls stubbed** (P7 follow-up) |
| `connector-slack` / `-salesforce` / `-microsoft365` / `-github` | Correct tool schemas, audit events, graceful "not configured" degradation | **All third-party HTTP calls return `{ stub: true }`; `sync()` → `records_synced: 0`.** No live external integration. |

**No fully-empty (C-tier) packages were found** — every reviewed package has at least a migration and real service logic. The B-tier items are **intentional phase gates** (P7/P8 / TK tasks), not abandoned code.

---

## 6. What will NOT work / cannot be claimed yet (the "stop" list)

1. **Zero-trust *mesh* as drawn (slide 25/15).** No SPIFFE/SPIRE, no Envoy PEP, no Cilium, no mTLS service mesh. If asked to "show the SVID / the mesh policy," there is nothing to show. *Claim the **control objective** (identity-bound, default-deny, audited), not the **vendor pattern**.*
2. **OPA/Cedar engine.** The policy engine is a bespoke IQL→Cedar-shape evaluator. Don't say "we run OPA/Cedar." Say "ABAC/ReBAC with a Cedar-compatible policy shape."
3. **OpenLineage / OCSF / Merkle-tree** wire formats. We have *equivalent* tamper-evident hash chains and a lineage graph, but **not** those named standards. Don't put OpenLineage/OCSF on a slide for *this* codebase.
4. **PAM / privileged-session brokering (CyberArk-class).** Not a product capability. `sdk-secrets` won't back it. This is an **Insignia consulting** offering only.
5. **Microsoft Purview / content-aware DLP / insider-risk.** Not in product. Consulting capability only.
6. **RealMDM-style probabilistic/AI-jury entity resolution + calibration.** ProjexCloud's resolver is deterministic canonical-ID; it does **not** implement the courseware's fuzzy-match + ECE-calibration + claims-not-merges machinery.
7. **Live external connector syncs (Slack/SFDC/M365/GitHub).** Stubbed — will return success-shaped no-ops. Never demo as a live integration.
8. **Stated SLOs (p99 latency, 50k EPS zero-loss, 10M-edge ReBAC, sub-ms projection, 60s fleet-wide revocation).** These are **design targets in PRDs/exit-gates**; this review did **not** load-test them. Treat as "designed-for," not "measured."
9. **On-prem / sovereign deployment variants (P8).** Largely scaffolded (`sdk-onprem`, `sdk-sovereign` B-tier). BYOK/CMEK in `sdk-vault` is real; the surrounding install/attestation tooling is not.
10. **"Builds green" is unverified.** Recent commits are `tsc`/build fixes and the tree is dirty. Run `pnpm -w build` + the isolation/chaos test suites before any technical due-diligence session.

---

## 7. ProjexCloud ↔ RealMDM / Developer MDM alignment

**Where they rhyme (concept parity, different stack):**
- Layered identity vs. "pure entity / contextual role" (Satya/Maya) — ProjexCloud's Master Person + Persona is the same instinct.
- Consent as purpose-bound + cross-border — both have it.
- Crypto-shred erasure ("Digital Ash") — `sdk-vault` shred ≈ RealMDM key-destruction proof.
- Event/lineage backbone, AI-as-governed-actor — ProjexCloud's agent-isolation runtime is a *stronger, shipped* version of "AI is observer, not author."
- ABAC + relationship contracts — ProjexCloud's ABAC+ReBAC maps to RealMDM's OPA + relationship-contracts.

**Where they diverge (do not conflate the two in a pitch):**
- **Stack:** RealMDM prescribes **Go/gRPC/Temporal/Kafka/Neo4j/OPA/OpenLineage**; ProjexCloud is **TypeScript/Fastify/Postgres/Drizzle/ClickHouse/pgvector** with a bespoke policy + lineage layer. They are **different implementations of similar ideas**, not the same system.
- **Entity resolution:** RealMDM's centerpiece (probabilistic + graph + AI-jury + calibration, "no Golden Record," event-sourced Reality Log) is **not** how ProjexCloud resolves identity. ProjexCloud is deterministic/canonical.
- **Temporal/durable portals & Neo4j graph-of-truth:** not present in ProjexCloud.

> If RealMDM is the **product being sold/spec'd to a client**, ProjexCloud is a **partial reference implementation of the governance + secure-data + AI-isolation planes**, missing the **probabilistic identity-resolution + Temporal-portal + graph** core. Scope any "we already built RealMDM" claim accordingly.

---

## 8. ProjexCloud ↔ Insignia capability inventory (extra · common · missing)

The Insignia deck is a **cybersecurity-services** deck — it only frames capability through a security lens (vuln-mgmt, AppSec, DLP, GRC, zero-trust, IAM/ABAC/consent, PAM, AI-security, detection/telemetry). ProjexCloud is a **product platform**, so it carries a large body of **business/operational/AI SDKs the deck never mentions** — these are exactly the capabilities a *customer* buys, not a security pod. This section inventories the three buckets and marks what we would have to **build/extend** to also satisfy the security-specific items the deck claims.

### 8.1 ProjexCloud has, Insignia deck does **not** mention (our extra value to customers)

These ship in the product (maturity per §4–§5) and are customer-facing differentiators the security deck is silent on. Maturity: **✅** substantially implemented · **🟡** partial/scaffolded.

| Domain | ProjexCloud SDKs / modules | Customer value the Insignia deck doesn't cover | Maturity |
|---|---|---|---|
| **Engagement & CRM** | `sdk-engagement`, `sdk-crm`, `sdk-campaign`, `sdk-social`, `sdk-lead-scoring`, `sdk-recommendation` | Built-in customer engagement, CRM, campaigns, lead scoring, recommendations — a *business* platform, not just controls | 🟡 (crm/engagement core; campaign/social/lead-scoring lighter) |
| **Content & conversation** | `sdk-content`, `sdk-conversation`, `sdk-notification` | CMS, multi-channel conversation (RAG-grounded), consent-gated notifications | ✅ content/conversation/notification |
| **Service & field ops** | `sdk-service-request`, `sdk-dispatch`, `sdk-assignment`, `sdk-event`, `sdk-storm`, `sdk-diagnostic-telemetry` | Field-service request → dispatch → assignment; event/ticketing; weather/storm triggers; device crash/health telemetry | ✅ event/diagnostic; 🟡 dispatch/assignment/storm |
| **Field capture (HDK)** | `hdk-camera`, `hdk-map`, `hdk-scanner`, `hdk-measure`, `hdk-watermark`, `hdk-image-editor`, `hdk-video-editor` | Evidence-grade mobile capture (GPS/IMU/device-stamped), measurement, watermarking — unique to field/insurance/healthcare verticals | 🟡 (capture core; measure/watermark P7) |
| **Commerce & billing** | `sdk-billing`, `sdk-payment`, `sdk-meter` | Usage metering, PCI-tokenized payments, invoicing, soft/hard quota caps — monetization the deck never touches | ✅ meter/billing; payment tokenization core |
| **Workflow & automation** | `sdk-workflow`, `sdk-approval`, `sdk-webhook` | Durable workflow, human-approval routing, outbound webhooks (incl. mTLS client-cert delivery) | ✅ approval/webhook; 🟡 workflow |
| **AI-native build & discovery** | `sdk-registry`, `sdk-catalog-index`, `sdk-capability`, `sdk-semantic`, `/build` planner, `sdk-agent-runtime`, `sdk-knowledge-rag`, `sdk-mcp-bridge` | **AI app-builder**: agents discover ~88 SDKs via RAG and compose apps; ontology/intent planner; MCP exposure. No equivalent anywhere in the deck | ✅ registry/catalog/semantic/agent-runtime/rag; 🟡 mcp-bridge |
| **Document AI** | `sdk-parsing`, `sdk-taxonomy`, `sdk-ingest`, `sdk-search`, `sdk-analytics` | 8-stage OCR→classify→extract→validate pipeline; ETL ingest front-door; ABAC-filtered search; analytics rollups | ✅ parsing/ingest/search; 🟡 taxonomy/analytics |
| **Multi-tenant SaaS infra** | `sdk-tenant`, `sdk-tenant-lifecycle`, `sdk-pool-router`, `sdk-feature-flags`, `sdk-profile`, `sdk-persona`, `sdk-projection`, `sdk-geo`, `sdk-device` | Recursive sub-tenants/resellers, pool isolation, active-active routing, feature flags, sub-ms identity projection — the *platform plumbing* a buyer inherits free | ✅ tenant/pool-router/projection/persona/profile |
| **Connectors** | `connector-*` (Salesforce, M365, Slack, Jira, Linear, Zendesk, HubSpot, Zoom, GitHub, Snowflake, GWorkspace) | 11 pre-built integration surfaces (schemas + audit + graceful degradation) | 🟡 (schemas real, live HTTP sync stubbed — see §5) |
| **Deployment variants** | `sdk-sovereign`, `sdk-onprem`, BYOK in `sdk-vault` | BYOK/CMEK ✅; sovereign/on-prem/air-gapped packaging | ✅ BYOK; 🟡 sovereign/onprem |

> **Takeaway:** to a customer, the *real* ProjexCloud advantage over a security-services engagement is everything in this table — a working multi-tenant product spine with engagement, commerce, field-ops, document-AI, and an AI app-builder. The Insignia deck sells *people and assessments*; ProjexCloud is *running software*.

### 8.2 Common to both (ProjexCloud product capability ⟷ Insignia security pattern)

Where ProjexCloud already implements the control the deck advertises (objective met; see §3 for any vendor-naming caveats).

| Capability | Insignia deck reference | ProjexCloud SDK(s) | Notes |
|---|---|---|---|
| Identity / OIDC / SAML / SCIM / MFA / impersonation | IAM (slide 16) | `sdk-identity` | ✅ |
| ABAC + ReBAC authorization | ABAC/OPA (16, 25, 28) | `sdk-policy`, `sdk-rebac` | ✅ control; 🟡 engine is Cedar-*shape*, not OPA/Cedar |
| Consent / purpose-of-use / cross-border | CMP / consent (16, 28) | `sdk-consent` | ✅ |
| MDM canonical identity / golden record | MDM (16, 28) | `sdk-identity-resolver` | ✅ deterministic; not RealMDM probabilistic |
| Tamper-evident audit ledger + customer export | Audit evidence (26, 31) | `sdk-audit` | ✅ hash-chain (not OCSF/Merkle) |
| Lineage / derivation chain | OpenLineage (25, 26) | `sdk-lineage`, `lineage-projector` | ✅ own model (not OpenLineage format) |
| Cross-system trace | Telemetry (25, 26) | `sdk-trace` | ✅ |
| Multi-tier vault + crypto-shred + BYOK/CMEK | Vault/secrets (17, 29) | `sdk-vault` | ✅ |
| Data-rights / DSAR / erasure / certificate | Privacy (28, 30) | `sdk-data-rights` | ✅ |
| AI security: agent isolation, tool allowlists, per-tenant memory, BYOK keys | AI security (18, 27) | `sdk-agent-runtime`, `sdk-ai-gateway`, `sdk-knowledge-rag` | ✅ **strongest match** |
| SIEM export of security events | Detection/telemetry (7, 17) | `sdk-vault` SIEM forwarder (Splunk/Elastic/Sumo) | 🟡 vault-event forwarding only, not full detection |

### 8.3 Insignia deck claims, ProjexCloud does **not** have — and what we'd extend to match

These are the security-specific capabilities the deck advertises that have **no product counterpart** today. Each row marks the **extension target** (existing SDK to grow, or a **new** package) and rough effort. "Effort" is relative engineering size, not a commitment.

| Missing capability | Insignia deck ref | Why it's missing | Extension target in ProjexCloud | Effort |
|---|---|---|---|---|
| **Zero-trust service mesh** (SPIFFE/SPIRE workload identity, Envoy PEP, Cilium, mTLS mesh) | slides 15, 25 | App-layer auth (JWT+RLS+Pool Router) used instead; no mesh | **Infra, not SDK** — adopt SPIRE + Envoy/Linkerd + Cilium at the deployment layer; issue SVIDs to services; keep app-layer authz on top | **L** (platform/infra program) |
| **Real OPA/Cedar policy engine** | 16, 25, 28 | `sdk-policy` is a custom IQL→Cedar-*shape* evaluator | **Extend `sdk-policy`**: emit real Cedar (or compile to OPA Rego) and run the genuine `cedar-policy`/OPA evaluator behind the same interface | **M** |
| **OpenLineage / OCSF standard formats** | 25, 26 | `sdk-lineage`/`sdk-audit` use proprietary schemas | **Extend `sdk-lineage`** (OpenLineage event emitter/adapter) + **`sdk-audit`** (OCSF-formatted export + Merkle-tree root option) | **S–M** (translation adapters) |
| **PAM / privileged-ops** (JIT credential broker, break-glass, SSH/RDP/DB/K8s session capture, CyberArk-class) | 17, 29 | `sdk-secrets` is only a KMS wrapper (no persistence/rotation) | **New `sdk-pam`** (or major `sdk-secrets` rebuild): credential vault of record, JIT issuance, break-glass workflow via `sdk-approval`, session recording + SIEM link | **L** |
| **Content-aware DLP / Microsoft Purview / sensitivity labels / insider-risk** | 13, 28 | No content scanner or Purview integration | **New `sdk-dlp`** + **`connector-purview`**: classification engine, sensitivity labels feeding ABAC tags, egress scanning, insider-risk signals | **L** |
| **Vulnerability management** (Tenable/Qualys/Rapid7 ingest, risk-based prioritization, SLA dashboards) | 11 | Not a product domain | **New `sdk-vuln`** + scanner connectors; reuse `sdk-meter`/`sdk-search`/dashboards | **M–L** |
| **AppSec / Secure-SDLC** (SAST/DAST/SCA triage, SBOM, signed provenance, container admission, CI/CD gates) | 12 | Not a product domain | **New `sdk-appsec`** + CI/CD policy gates; tie SBOM/provenance into `sdk-audit` evidence | **M–L** |
| **GRC tooling integration** (AuditBoard / SAI360 / ServiceNow GRC, control libraries, evidence workflows) | 14 | No GRC workflow layer | **New `sdk-grc`** + connectors; map controls to existing `sdk-audit` evidence export | **M** |
| **Detection engineering / SIEM-XDR** (alert tuning, use-cases, runbooks) | 7, 10 | Only vault-event SIEM forwarding | **Extend SIEM forwarder → `sdk-detection`**: route audit/trace/meter streams to SIEM/XDR with detection rules | **M** |
| **AI-security governance gaps**: formal **prompt registry**, **RAG-corpus sensitivity classification**, **AI-DLP egress scanning**, **eval/drift harness** (shadow/canary), model cards (NIST AI RMF) | 18, 27, 30 | Partial — tool allowlists/metering/audit exist; the rest is design-level | **Extend `sdk-ai-gateway`** (prompt registry + AI-DLP egress) + **`sdk-knowledge-rag`** (corpus classification) + **new `sdk-ai-eval`** (eval/drift/calibration, model cards) | **M** |
| **Probabilistic / AI-jury entity resolution + calibration** (RealMDM-style) | RealMDM courseware | ProjexCloud resolver is deterministic | **Extend `sdk-identity-resolver`**: probabilistic + graph + calibrated-AI matching, claims-not-merges, ECE monitoring | **L** |

> **Reading guide for the team:** rows marked **S/M** are *adapters and extensions of existing SDKs* (cheap, high-credibility — do these first when a deal needs the literal claim). Rows marked **L** are *new product surfaces or infra programs* (PAM, DLP, vuln-mgmt, AppSec, zero-trust mesh) — these are genuinely **Insignia consulting territory**, and the honest position is "we partner/consult for these, we don't ship them yet."

---

## 9. Recommendations

**Safe to claim now (with the demo caveats above):**
- Multi-tenant identity/ABAC/ReBAC/consent spine; 7-tier crypto-shred vault + BYOK; append-only hash-chained audit + DSAR + certificate-of-shred; cross-system trace + metering; **agent-isolation runtime (capability tokens / TTL / replay / sandboxed memory)** — this last is the **single most differentiated, demoable asset** and aligns precisely with deck slide 27.

**Reframe before claiming (objective, not vendor):**
- Zero-trust → "app-layer zero-trust (JWT + RLS + Pool Router)," not "SPIFFE/Envoy mesh."
- Policy → "ABAC/ReBAC, Cedar-compatible policy shape," not "OPA/Cedar."
- Evidence → "tamper-evident hash-chained audit + lineage graph," not "OCSF/OpenLineage/Merkle."

**Close before a technical due-diligence demo (priority order):**
1. Get `pnpm -w build` + the agent-isolation/chaos suites **green**; capture the output as evidence.
2. Pick **one** connector and make it a **real** integration end-to-end (kills the "it's all stubs" risk).
3. Add the missing slide-26 evidence fields (`business_reason`, `policy_bundle_hash`, signed root) to audit events if you want to claim the full evidence model.
4. Decide the **OpenLineage/OCSF** question: either add a translation/export adapter (cheap, high-credibility) or remove those standards from the deck for this codebase.
5. Land the deferred `sdk-evidence` legal-export + retention-shredder if "chain-of-custody / legal export" will be claimed.

**Keep clearly separated in messaging:**
- **Insignia *consulting* capabilities** (PAM, Purview/DLP, vuln-mgmt, GRC, pen-test) — *services*, not ProjexCloud features.
- **ProjexCloud *product* capabilities** — the identity/AI/evidence spine above.
- **RealMDM** — a *different, more ambitious* MDM product/spec that ProjexCloud only partially realizes.

---

## 10. Appendix — package maturity index (static review)

**A-tier (substantially implemented):** sdk-identity, sdk-identity-resolver, sdk-rebac, sdk-policy, sdk-persona, sdk-tenant, sdk-tenant-lifecycle, sdk-consent, sdk-data-rights, sdk-audit, sdk-lineage, sdk-trace, sdk-vault, sdk-api-keys, sdk-event, sdk-diagnostic-telemetry, sdk-meter, sdk-ai-gateway, sdk-agent-runtime, sdk-knowledge-rag, sdk-semantic, sdk-catalog-index, sdk-registry, sdk-capability, sdk-search, sdk-projection, sdk-profile, sdk-parsing, sdk-media, sdk-content, sdk-conversation, sdk-pool-router, sdk-ingest; services: api-gateway, identity-projector, lineage-projector, meter-collector, semantic-service, registry-mcp, pool-federation-runtime; apps: projexcloud-admin, tenant-admin, tenant-workspace.

**B-tier (partial / phase-gated):** sdk-evidence, sdk-secrets, sdk-mcp-bridge, sdk-taxonomy, sdk-sovereign, sdk-onprem, sdk-storm, connector-slack, connector-salesforce, connector-microsoft365, connector-github.

**C-tier (empty stub):** none found.

**Not individually re-verified in this pass** (assumed per design): the remaining ~10 connectors (jira/linear/zendesk/hubspot/zoom/gworkspace/snowflake/salesforce-bulk), hdk-* capture modules (camera/map/scanner/measure/watermark/image-editor/video-editor), sdk-billing/payment/notification/workflow/approval/webhook/campaign/crm/engagement/social/recommendation/analytics/geo/device/feature-flags/dispatch/assignment/lead-scoring/onprem runtime, and the clickhouse/kafka/redis runtime packages. These should be spot-checked before any claim that depends on them.

---

*End of report. This is an engineering reality-check intended to keep product claims defensible in front of a technical buyer or auditor; it is deliberately conservative where runtime behaviour was not executed.*
