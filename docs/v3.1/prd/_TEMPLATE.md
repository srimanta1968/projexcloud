# PRD · P{N} — {Theme}

| Field | Value |
|---|---|
| **Phase** | P{N} |
| **Window** | Weeks {start}–{end} (~{n} weeks) |
| **Maps to wave(s)** | W{n} |
| **Gates closed** | G{x} · G{y} (matches SDK-Build-Plan §0A.2) |
| **Status** | DRAFT / IN-REVIEW / APPROVED / IN-FLIGHT / EXITED |
| **Owner (DRI)** | {name / role} |
| **Companion docs** | `../docs/v3.1/Architecture-v3.1.html` · `../docs/v3.1/SDK-Build-Plan-v3.1.html` §{xx} · `../docs/v3.1/ProjectStructure-v3.1.html` |

---

## 1 · TL;DR

(3–5 sentences. What this phase delivers, why it matters, what it unblocks.)

---

## 2 · Why this phase now

(The dependency rationale — copied from `SDK-Build-Plan-v3.1.html §0A`. Explain what would break if this phase were delayed or de-scoped.)

---

## 3 · What ships in this phase

| Component | Type | Effort | Owner | Notes |
|---|---|---|---|---|
| `@projexlight/sdk-{name}` | SDK · NEW or EXTENDED | S/M/L/XL · {n}w | {team} | Brief one-liner |
| `services/{service-name}` | Service binary | … | … | … |
| `apps/{app-name}` | Portal / app | … | … | … |
| `native/hdk-{name}` | HDK module | … | … | … |
| **Doctrine** §X.Y in Architecture | Architecture doc | — | Platform Architect | One-paragraph rule |

---

## 4 · User stories

### As a **Platform Engineer**
- **US-PE-1**: As a platform engineer, I want {capability} so that {outcome}.
- **US-PE-2**: …

### As a **Vertical Product Engineer**
- **US-VE-1**: …

### As a **ProjexCloud Operator** (internal staff)
- **US-OP-1**: …

### As a **Tenant Admin**
- **US-TA-1**: …

### As a **Tenant Developer**
- **US-TD-1**: …

### As a **Tenant Employee / End User**
- **US-EU-1**: …

---

## 5 · Functional requirements (per SDK / component)

### 5.1 · `@projexlight/sdk-{name}`

**Purpose:** (one sentence)

**Owns:**
- FR-{ID}-1: {requirement}
- FR-{ID}-2: …

**Public API surface (selected):**
```ts
// Concrete API examples — the actual signatures every consumer will use
export async function {fn}({args}): Promise<{ReturnType}>;
```

**Database / storage:**
- Schema: `{schema_name}` in {pool family}
- Key tables: `{table_1}`, `{table_2}`
- RLS: per `tenant_id`
- Non-OLTP: {ClickHouse / OpenSearch / Kafka / Redis / S3 / Vault / Vector / Iceberg — as applicable}

**Events published:**
- `{namespace}.{action}.v1` — retention class: {transient/operational/regulated} — conflict policy: {crdt/lww/merge/event-sourcing/human-review}

**Events subscribed:**
- `{namespace}.{action}.v1` from {producer SDK}

**Pool placement:** {Admin / App / Evidence / Global Catalog / Warehouse / Vector / OLAP} (cross-ref §8A)

**SKUs (pricing surface):** `{sdk}.{method}.{tier}` — {pricing mode}

### 5.2 · {Next SDK / component}
…

---

## 6 · Non-functional requirements

| Dimension | Target |
|---|---|
| Latency (p99) | {budget} |
| Throughput | {target} |
| Availability | {SLO} |
| Durability | {RPO / RTO} |
| Security | {encryption · authz · audit} |
| Compliance | {GDPR / HIPAA / DPDP / PCI / SOC2 — as applicable} |
| Cost guardrails | {budget per tenant per month / per call} |

---

## 7 · Acceptance criteria (the phase exit gate)

These ARE the conditions in `SDK-Build-Plan-v3.1.html §0A.4` for this phase, broken into testable items. **The phase is "done" only when every item below is independently verified.**

| # | Criterion | Owner | Test plan |
|---|---|---|---|
| **AC-1** | {Specific, testable condition} | {team / role} | {How it's verified — chaos test, integration test, load test, CI gate, manual demo} |
| **AC-2** | … | … | … |

---

## 8 · Test plan (per acceptance criterion)

### AC-1 · {Criterion title}
**Scenario:** (Given / When / Then or a concrete walkthrough)

**Test type:** {Unit / Integration / Contract / Chaos / Load / Manual}

**Environment:** {dev / staging / prod-like / chaos pod}

**Pass condition:** {explicit measurable bar}

**Evidence captured:** {test logs, audit chain entry, trace_id, screenshots}

### AC-2 · …
…

---

## 9 · Dependencies (what must be true entering this phase)

- ✅ Phase P{N-1} exit gate green (every AC of prior phase verified)
- ✅ {Specific upstream SDK} v1.0 published with stable API
- ✅ {Specific infrastructure} provisioned (Kafka cluster · ClickHouse · KMS · …)
- ✅ {Working Group} sign-off on contracts changes

---

## 10 · Out of scope (deferred to later phases)

- ❌ {Feature / capability} → planned for P{N+1}
- ❌ {Optimization / hardening} → planned for P{N+2} or backlog

---

## 11 · Risks

| # | Risk | Severity | Likelihood | Mitigation |
|---|---|---|---|---|
| R-1 | {What could go wrong} | H/M/L | H/M/L | {Specific countermeasure with owner} |
| R-2 | … | … | … | … |

---

## 12 · Rollout plan

1. **Internal alpha** (week {n}): {scope of access}
2. **Staging deploy** (week {n}): {scope}
3. **Per-region rollout** (week {n}): {region order — typically dev region → primary region → secondary regions}
4. **Production gate** (week {n}): {what must be true before flipping the switch}
5. **Customer-facing announcement** (week {n}): {channel, audience}

---

## 13 · Open questions / decisions needed

- [ ] Q-1: {Specific question that must be resolved before {date / decision point}}
- [ ] Q-2: …

---

## 14 · Sign-off

| Role | Name | Date | Status |
|---|---|---|---|
| Phase DRI | | | |
| Platform Architect | | | |
| Identity Working Group | | | |
| Security / Compliance | | | |
| Engineering Lead | | | |
