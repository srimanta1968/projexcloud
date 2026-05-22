# ProjexCloud · v3.1 Product Requirements Documents (PRDs)

This folder contains the **phase-aligned PRDs** that turn the v3.1 design (docs in `../docs/v3.1/`) into executable engineering scope. Each PRD covers one phase of the SDK Build Plan and is the authoritative source for:

- **What the phase delivers** (SDKs, services, doctrines, deployment variants)
- **User stories** for each affected audience
- **Functional requirements** per SDK / component
- **Acceptance criteria** (the phase exit gate, broken into testable items)
- **Test plan** for each acceptance criterion
- **Dependencies** from prior phases
- **Out-of-scope items** (explicitly deferred)
- **Risks + mitigations**
- **Rollout plan**

---

## The PRD set (one per phase)

| PRD | Phase | Weeks | Theme | Gates closed |
|---|---|---|---|---|
| [P1-Foundation-Spine.md](./P1-Foundation-Spine.md) | P1 | 1–9 | Foundation + Doctrines (Contracts · Vault · Audit · Pool Router · Meter + Opinionated Constraints + Polyglot Persistence) | G1 · G2 · G3 |
| [P2-Identity-Access.md](./P2-Identity-Access.md) | P2 | 9–15 | Identity & Access at scale (Tenant · Identity · Consent · Policy+IQL · ReBAC+safeguards · API Keys · Identity Projection) | G4 |
| [P3-Canonical-Privacy-HDK.md](./P3-Canonical-Privacy-HDK.md) | P3 | 15–22 | Canonical Entities + Privacy Ops + HDK Foundation (Profile · Persona · Geo · Device · Resolver · Data Rights · HDK foundations + sync · Conflict Resolution Model) | G5 · G6 |
| [P4-Operational-Billing.md](./P4-Operational-Billing.md) | P4 | 22–29 | Operational Core + Billing + Integration framework (Media · Notification · Payment · Workflow · Search · Billing · Webhook · Approval · Tenant Lifecycle · sdk-connectors + connector-slack · HDK camera/map) | — |
| [P5-Engagement-Connectors.md](./P5-Engagement-Connectors.md) | P5 | 29–35 | Engagement (Domain Layer) + Enterprise Connectors (Engagement · CRM · Content · SR · Event · Campaign · Social · connector-salesforce/m365/gworkspace/jira/linear/zendesk/hubspot/zoom · HDK editors) | — |
| [P6A-AI-Isolation-MCP.md](./P6A-AI-Isolation-MCP.md) | P6A | 35–40 | AI Infrastructure + Agent Isolation + MCP Bridge (AI Gateway · Taxonomy · Agent Runtime with full isolation · sdk-trace · sdk-mcp-bridge · connector-github) | G7 · G12 |
| [P6B-Knowledge-Semantic.md](./P6B-Knowledge-Semantic.md) | P6B | 40–44 | Knowledge + Semantic + Analytics + Snowflake (RAG · Parsing · Conversation · Recommendation · Analytics+Iceberg · Lineage+cross-pool · Semantic 6 types · connector-snowflake) | G8 · G9 |
| [P7-Field-Hyperscale.md](./P7-Field-Hyperscale.md) | P7 | 44–50 | Field + Evidence + Hyperscale (Storm · Dispatch · Assignment · Lead Scoring · Evidence · Diagnostic-Telemetry · HDK measure/watermark · Pool federation runtime · hard caps on) | G10 · G11 |
| [P8-Deployment-Variants.md](./P8-Deployment-Variants.md) | P8 | parallel from 22 | Deployment Variants (BYOK/CMEK · Sovereign Cloud · On-Prem/Air-Gapped · Active-Active Tier-G+) | — |

---

## How to use these PRDs

1. **Reading order.** Start with `P1` and read sequentially. Each PRD assumes the prior phase's exit gate has been met. Out-of-order reading misses the dependency story.
2. **Engineering workflow.** Each PRD's *Functional Requirements* section is the source for breaking down per-SDK tickets. Each *Acceptance Criterion* maps directly to a test or chaos drill.
3. **Phase entry condition.** A phase is *startable* only when the prior phase's PRD is closed (every acceptance criterion green). CI enforces this — see SDK-Build-Plan §0A.4 "no-leak rules."
4. **Phase exit condition.** A phase is *closed* only when every acceptance criterion in its PRD is independently verified by the named test plan. Working group sign-off required.
5. **Changes to a PRD.** Treat PRDs like code: changes require PR review by the phase owner + the working group whose contracts the change touches. Don't update a PRD silently — downstream phases depend on it.

---

## Cross-references

| You're looking for | Document |
|---|---|
| The architectural why | `../docs/v3.1/Architecture-v3.1.html` |
| The dependency-driven phase plan | `../docs/v3.1/SDK-Build-Plan-v3.1.html` §0A |
| The six-layer identity model | `../docs/v3.1/AIM-Identity-Model-v3.1.html` |
| How code is organized (repos, SDKs, DBs, portals) | `../docs/v3.1/ProjectStructure-v3.1.html` |
| Agentic substrate + third-party integration | `../docs/v3.1/AgenticIntegration-v3.1.html` |
| **What to build in each phase, with acceptance criteria** | **this folder — `prd/Pn-*.md`** |
| Canonical PRD template (for new phases or refinements) | [`_TEMPLATE.md`](./_TEMPLATE.md) |

---

## The 12 gaps (G1–G12) referenced by PRDs

These are the architectural gaps identified in `SDK-Build-Plan-v3.1.html §0A.2`. Each PRD's acceptance criteria explicitly close the gaps assigned to its phase. Quick reference:

| # | Gap | Closed in |
|---|---|---|
| G1 | Opinionated Constraints + "Localize Complexity" doctrines | P1 |
| G2 | Polyglot Persistence doctrine | P1 |
| G3 | Event Type Registry enforced from week 1 | P1 |
| G4 | Identity Projection System | P2 |
| G5 | person_pool_residency registry | P3 |
| G6 | Conflict Resolution Model + hdk-sync | P3 |
| G7 | Agent Isolation Runtime (full primitives) | P6A |
| G8 | Cross-pool lineage projection worker | P6B |
| G9 | SemanticIntent + SemanticPolicy | P6B |
| G10 | Pool federation runtime | P7 |
| G11 | Read federation lakehouse (Iceberg) | P7 |
| G12 | Cross-system trace viewer (sdk-trace) | P6A |
