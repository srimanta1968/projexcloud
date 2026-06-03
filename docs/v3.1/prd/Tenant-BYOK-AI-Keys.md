# PRD · Tenant-BYOK for AI Provider Keys

| Field | Value |
|---|---|
| **Phase** | P6A extension (E1) |
| **Window** | Weeks 1–2 (~2 weeks) — fast-follow to P9 GA |
| **Maps to wave(s)** | Post-P6A hardening |
| **Gates closed** | (extension) — G7 AI Isolation already closed; this PRD adds tenant-scope credential isolation |
| **Status** | DRAFT — pending review |
| **Owner (DRI)** | AI Gateway Lead · Security / Compliance reviewer |
| **Companion docs** | `../docs/v3.1/prd/P6A-AI-Isolation-MCP.md` · `../docs/v3.1/Architecture-v3.1.html` · `packages/sdk-ai-gateway/src/services/credentialBootstrap.ts` · `packages/sdk-vault/src/services/byok/byokService.ts` |

---

## 1 · TL;DR

Today every tenant on the AI gateway routes through one platform-level credential per provider (`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `AWS_BEDROCK_ACCESS_KEY`, `GEMINI_API_KEY` from `.env` → `ai_gateway.provider` row). Regulated buyers cannot adopt the gateway in this shape — they need to hold their own LLM bill, see their own usage on their own provider dashboard, and revoke at will. This extension adds **per-tenant provider credentials** with a transparent fall-through to the platform credential, vault-wrapped secrets, write-only admin UI, audit on every bind/rotate/revoke, and a meter-side switch that drops the AI-token markup when a tenant is on their own key. Scope deliberately excludes: per-app or per-persona key scoping (deferred), tenant-managed routing policy (deferred), and BYOK for non-LLM connectors (deferred).

---

## 2 · Why this phase now

Three forces converge:

1. **Pricing-page commitment.** The new public pricing surface (Starter / Pro / Enterprise) lists BYOK for AI keys as a Pro/Enterprise differentiator. Without it, the page either lies or we lose the regulated-enterprise tier of leads.
2. **AI gateway COGS exposure.** Platform-key tenants on Frontier models (Opus, GPT-4o, Gemini 1.5 Pro) consume tokens that we eat-then-bill. A small number of power users can blow the unit economics of any flat-priced tier. Tenant-BYOK puts those users on their own provider invoice and converts the gateway from a pass-through cost center into a pure governance/audit SaaS line item.
3. **Compliance ask.** SOC 2, HIPAA, and FedRAMP-Moderate auditors increasingly require *customer-managed* credentials for any service that handles regulated content. We already meet this bar for encryption (CMEK via `sdk-vault` BYOK); the AI gateway is the last data-touching surface that doesn't.

Delaying past Q3 2026 means the pricing page ships with a "coming soon" badge that ages badly, and one or two regulated deals stall.

---

## 3 · What ships in this phase

| Component | Type | Effort | Owner | Notes |
|---|---|---|---|---|
| `ai_gateway.tenant_provider_credential` table + migration | Schema · NEW | S · 1d | AI Gateway Lead | Tenant-scoped credential envelope, RLS by `tenant_id`, status enum, optional `model_allowlist` |
| `credentialBootstrap` / `loadProviderRow` resolver update | SDK · EXTENDED | S · 1d | AI Gateway Lead | `loadProviderRow(tenant_id, provider_id)` falls through to platform row if no tenant row exists |
| `sdk-secrets` envelope helper for provider creds | SDK · EXTENDED | S · 0.5d | Security WG | Vault-wrap the raw provider key, return `{ref, wrapped}` envelope. Reuses existing `sdk-vault` envelope shape |
| `sdk-ai-gateway` write endpoints (`POST/PATCH/DELETE /api/ai-gateway/tenant-credentials`) | SDK · EXTENDED | M · 2d | AI Gateway Lead | Bind, rotate, revoke. JWT-gated, `tenant.admin` scope. Audit on every op |
| `apps/tenant-admin/src/app/ai/providers/page.tsx` | Portal · NEW | M · 2d | Tenant Product Lead | Write-only key input, last-4 display, status badge per provider, rotate / revoke buttons |
| `sdk-meter` BYOK detection + SKU rate switch | SDK · EXTENDED | S · 1d | Billing Lead | When the completion uses a tenant credential, drop the per-token markup SKU and bill the gateway-call SKU only |
| `sdk-audit` event types (`ai_gateway.tenant_credential.bound.v1` / `.rotated.v1` / `.revoked.v1`) | Contracts · NEW | S · 0.5d | Platform Architect | Added to `packages/contracts/src/events.ts`, regulated retention class |
| **Doctrine §E — Credential Locality** in Architecture | Architecture doc | — | Platform Architect | One-paragraph rule: tenant-scoped data → tenant-scoped credentials; platform credentials are fallback only |

---

## 4 · User stories

### As a **Platform Engineer**
- **US-PE-1**: As a platform engineer, I want `loadProviderRow` to resolve tenant credentials before platform ones so that the same completion path serves both BYOK and non-BYOK tenants with no branching at call sites.
- **US-PE-2**: As a platform engineer, I want every bind/rotate/revoke to emit a regulated-class audit event so compliance can prove the credential lifecycle is governed.

### As a **Tenant Admin**
- **US-TA-1**: As a tenant admin, I want to paste my OpenAI / Anthropic / Bedrock / Gemini key in `/ai/providers` so that all AI completions for my tenant bill to my account, not ProjexCloud's.
- **US-TA-2**: As a tenant admin, I want to revoke a tenant credential and have completions fall back to the platform key (with billing implications shown in the UI) so I can rotate without an outage.
- **US-TA-3**: As a tenant admin, I want to see only the last 4 characters of any bound key after save so the secret is never re-displayed in the browser.

### As a **Tenant Developer**
- **US-TD-1**: As a tenant developer calling the AI gateway, I want no behavior change when my org switches from platform-keys to tenant-BYOK — same endpoint, same JWT, same response shape.

### As a **ProjexCloud Operator** (internal staff)
- **US-OP-1**: As an operator, I want a `/admin/ai-gateway/tenant-credentials/{tenant_id}` read-only diagnostic surface so I can see *which* tenants are on BYOK without seeing key material.

### As a **Compliance Auditor** (external)
- **US-CA-1**: As an auditor reviewing this tenant, I want to query the audit ledger and see every bind/rotate/revoke event with actor, timestamp, and provider — proving the customer holds the off-switch.

---

## 5 · Functional requirements

### 5.1 · `@projexlight/sdk-ai-gateway` (extended)

**Purpose:** Add a per-tenant credential layer on top of the existing platform-credential bootstrap, transparent to callers.

**Owns:**
- **FR-BYOK-1**: New table `ai_gateway.tenant_provider_credential` with columns: `binding_id UUID PK`, `tenant_id UUID NOT NULL`, `provider_id TEXT NOT NULL`, `credential_envelope BYTEA NOT NULL`, `status TEXT NOT NULL CHECK (status IN ('active','revoked'))`, `model_allowlist TEXT[] NULL`, `last_4 TEXT NOT NULL`, `bound_at TIMESTAMPTZ NOT NULL DEFAULT now()`, `revoked_at TIMESTAMPTZ NULL`, `bound_by TEXT NOT NULL`, `revoked_by TEXT NULL`. Unique on (`tenant_id`, `provider_id`) WHERE `status='active'`. RLS by `tenant_id`.
- **FR-BYOK-2**: `loadProviderRow(tenant_id, provider_id)` resolves in this order: (1) tenant active credential, (2) platform credential. If neither exists for a *required* provider, the request fails with `provider_unavailable`.
- **FR-BYOK-3**: `bindTenantCredential({tenant_id, provider_id, raw_key, model_allowlist?, actor_id})` vault-wraps the key via `sdk-secrets`, inserts an `active` row (revoking any pre-existing active row for that pair in the same transaction), and emits `ai_gateway.tenant_credential.bound.v1`.
- **FR-BYOK-4**: `rotateTenantCredential({binding_id, raw_key, actor_id})` updates the envelope in-place, preserves `binding_id`, emits `ai_gateway.tenant_credential.rotated.v1`. No grace window required because the gateway re-reads the envelope on every completion (per `completionService.ts:217`).
- **FR-BYOK-5**: `revokeTenantCredential({binding_id, reason, actor_id})` flips status to `revoked`, sets `revoked_at`/`revoked_by`, emits `ai_gateway.tenant_credential.revoked.v1`. Subsequent completions fall through to the platform credential.
- **FR-BYOK-6**: Optional `model_allowlist` (e.g. `['gpt-4o','gpt-4o-mini']`) restricts which models the tenant credential is used for; out-of-list requests fall through to platform credential. Default NULL = all models.

**Public API surface:**
```ts
// packages/sdk-ai-gateway/src/services/tenantCredentialService.ts
export interface TenantCredentialBinding {
  binding_id: string;
  tenant_id: string;
  provider_id: ProviderId;
  status: 'active' | 'revoked';
  model_allowlist: string[] | null;
  last_4: string;
  bound_at: string;
  revoked_at: string | null;
}

export async function bindTenantCredential(input: {
  tenant_id: string;
  provider_id: ProviderId;
  raw_key: string;
  model_allowlist?: string[];
  actor_id: string;
}): Promise<TenantCredentialBinding>;

export async function rotateTenantCredential(input: {
  binding_id: string;
  raw_key: string;
  actor_id: string;
}): Promise<TenantCredentialBinding>;

export async function revokeTenantCredential(input: {
  binding_id: string;
  reason: string;
  actor_id: string;
}): Promise<TenantCredentialBinding>;

export async function listTenantCredentials(input: {
  tenant_id: string;
}): Promise<TenantCredentialBinding[]>;
```

**Database / storage:**
- Schema: `ai_gateway` in App pool family
- Key tables: `tenant_provider_credential` (new), `provider` (existing — unchanged)
- RLS: per `tenant_id`
- Non-OLTP: vault envelope refs stored via `sdk-vault` Tenant Key (already exists)

**Events published:**
- `ai_gateway.tenant_credential.bound.v1` — retention: regulated · conflict: event-sourcing (immutable)
- `ai_gateway.tenant_credential.rotated.v1` — retention: regulated · conflict: event-sourcing
- `ai_gateway.tenant_credential.revoked.v1` — retention: regulated · conflict: event-sourcing

**Events subscribed:** none (this is a write surface)

**Pool placement:** App (same pool as the rest of `sdk-ai-gateway`)

**SKUs (pricing surface):**
- `ai-gateway.completion.governance` — fixed per-call SKU billed even when tenant uses their own provider key (covers gateway, audit, policy, soft-cap enforcement). This SKU **already exists** but is currently not used; the meter switch makes it the dominant SKU for BYOK tenants.
- `ai-gateway.tokens.{provider}.{tier}` — existing per-token markup SKU. Suppressed when the completion used a tenant credential.

### 5.2 · `@projexlight/sdk-secrets` (extended)

**Purpose:** Reuse the existing vault envelope shape for AI provider keys; no new public API.

**Owns:**
- **FR-BYOK-7**: `wrapProviderCredential(raw_key, tenant_id)` returns `{ref, wrapped}` envelope using the tenant's existing Tenant Key (or platform key if tenant has no CMEK binding).
- **FR-BYOK-8**: `unwrapProviderCredential(envelope)` is internal-only — called by `completionService.unwrapCredential` (existing function) which already handles the platform envelope shape. The tenant envelope mirrors it.

### 5.3 · `@projexlight/sdk-meter` (extended)

**Purpose:** Detect BYOK usage on each completion and emit the right SKU.

**Owns:**
- **FR-BYOK-9**: The completion path stamps `credential_source` (`'platform'` or `'tenant'`) onto the meter event payload. The meter ingest worker reads it and either emits `ai-gateway.tokens.{provider}.{tier}` (platform) or skips it (tenant). The `ai-gateway.completion.governance` SKU is emitted unconditionally.

### 5.4 · `apps/tenant-admin` (extended)

**Purpose:** Tenant-facing UI to manage AI provider credentials.

**Route:** `/ai/providers`

**Owns:**
- **FR-BYOK-10**: List all four providers (anthropic, openai, bedrock, gemini) as rows. Each row shows: provider name, current source (`platform fallback` or `tenant binding`), if tenant: `last_4`, `bound_at`, status, action buttons.
- **FR-BYOK-11**: "Bind key" modal: write-only `<input type="password">` for the raw key, optional model-allowlist multi-select, submit POSTs to gateway. Raw key is **never** rendered in the response or re-displayed.
- **FR-BYOK-12**: "Rotate" reuses the same modal with the existing `binding_id`.
- **FR-BYOK-13**: "Revoke" requires a typed-reason confirmation (minimum 6 chars) — mirrors the existing CMEK BYOK pattern at `apps/tenant-admin/src/app/byok/page.tsx:60`.
- **FR-BYOK-14**: Banner above the table: "When using your own provider key, ProjexCloud bills only the gateway governance SKU. Token costs go to your provider invoice."

---

## 6 · Non-functional requirements

| Dimension | Target |
|---|---|
| Latency (p99) | Completion path overhead vs. baseline: ≤ 2 ms (one extra row lookup, hot path tenant lookup cached for 60 s) |
| Throughput | No regression vs. existing AI gateway throughput |
| Availability | Inherits `sdk-ai-gateway` 99.9% (Pro) / 99.99% (Enterprise) |
| Durability | Vault envelope durability = `sdk-vault` Tenant Key durability (region-replicated) |
| Security | Raw key never persisted in plaintext; never logged; never returned in any GET response (only `last_4`). Vault wrap uses tenant CMEK if bound, platform key otherwise |
| Compliance | SOC 2 (CC6.1 — logical access), HIPAA (§164.312(a)(2)(iv) — encryption/decryption), FedRAMP-Moderate (SC-12 — key establishment) |
| Cost guardrails | No new infra cost; reuses existing Postgres + vault + audit pipeline |

---

## 7 · Acceptance criteria (the phase exit gate)

| # | Criterion | Owner | Test plan |
|---|---|---|---|
| **AC-1** | A tenant admin can bind, rotate, and revoke a provider credential through `/ai/providers`. Every action emits a regulated-class audit event with actor, timestamp, provider, and `binding_id`. | Tenant Product Lead | Playwright end-to-end: signup → bind OpenAI → call `/api/ai-gateway/completions` → revoke → verify completion falls back to platform → audit chain has 2 events |
| **AC-2** | When a tenant has an active credential for a provider, the completion uses it; when none exists, it falls back to the platform credential transparently. No code change required in callers. | AI Gateway Lead | Integration test: two tenants, one BYOK + one platform, both call the same endpoint, both succeed, traffic captured in `ai_gateway.completion` proves correct credential resolution |
| **AC-3** | Raw key material is never exposed after save. GET endpoints return only `last_4`. Audit events do not include raw material. Postgres dump shows envelope BYTEA only. | Security WG | Manual: bind a key, query every read path (UI, GET endpoint, audit ledger, DB dump). grep for the raw key value across all → must return 0 hits |
| **AC-4** | Meter emits `ai-gateway.completion.governance` for every BYOK completion and *does not* emit `ai-gateway.tokens.*` for those calls. | Billing Lead | Integration: BYOK tenant runs 100 completions; meter ledger has 100 governance SKU rows and 0 token SKU rows; non-BYOK tenant comparison has both |
| **AC-5** | `model_allowlist` is honored: a request for a model not in the list falls through to the platform credential. | AI Gateway Lead | Integration: bind OpenAI with `allowlist=['gpt-4o-mini']`, request `gpt-4o` → call uses platform credential; request `gpt-4o-mini` → call uses tenant credential. Verify via audit + meter source field |
| **AC-6** | Revoking a credential renders future calls fallthrough within 5 s (matches the gateway's existing 5 s cache TTL on provider rows). | AI Gateway Lead | Integration: bind, make 1 call (tenant), revoke, wait 5 s, make 1 call → uses platform. Less than 5 s after revoke → may still hit tenant (acceptable cache window, documented) |
| **AC-7** | Documentation: `docs/v3.1/runbook/byok-ai-keys.md` walks through bind/rotate/revoke + troubleshooting; `docs/user/tenant-admin-guide.md` adds an `/ai/providers` section. | Developer Experience Lead | Doc review by Security WG + one external tenant pilot |

---

## 8 · Test plan (selected)

### AC-1 · Bind / rotate / revoke + audit
**Scenario:** Tenant admin Alice signs in, navigates to `/ai/providers`, pastes a valid OpenAI test key, submits. UI shows `bound` + `last_4=XXXX`. She calls `POST /api/ai-gateway/completions` with model `gpt-4o`. She revokes the binding with reason "rotating to new account". She makes the same completion call again.

**Test type:** Integration + manual UI

**Environment:** dev region with synthetic OpenAI MCP fixture (`MCP_FIXTURE_OPENAI_URL`)

**Pass condition:**
- First completion's trace_id audit row shows `credential_source=tenant`
- Audit ledger contains `ai_gateway.tenant_credential.bound.v1` and `ai_gateway.tenant_credential.revoked.v1` with `actor_id=alice`
- Second completion's audit row shows `credential_source=platform`

**Evidence captured:** Playwright video, audit chain export, two completion trace_ids

### AC-3 · No raw-key exposure
**Scenario:** Bind a key with value `sk-test-CAFEBABE0123456789DEADBEEF`. Inspect: (a) DB dump of `tenant_provider_credential` table, (b) audit ledger entries, (c) every GET endpoint that touches the row, (d) browser network panel after save, (e) gateway logs.

**Test type:** Manual security review

**Pass condition:** `grep CAFEBABE0123456789DEADBEEF` returns 0 matches across all five surfaces

**Evidence captured:** Security WG sign-off ticket

---

## 9 · Dependencies (what must be true entering this phase)

- ✅ P6A AI Gateway G7 closed — `ai_gateway.provider` + `credentialBootstrap` are live in prod
- ✅ `sdk-vault` BYOK / CMEK shipped — tenant Tenant Keys exist for envelope wrap
- ✅ `sdk-audit` regulated retention class is live
- ✅ `sdk-meter` has SKU-level routing (added in P6A)
- ✅ `apps/tenant-admin` Next app is in prod (current state)

---

## 10 · Out of scope (deferred to later phases)

- ❌ Per-app or per-persona credential scoping (one credential per `(tenant_id, provider_id)` only) → backlog, evaluate after first 10 BYOK customers
- ❌ Tenant-managed routing policy (which model goes where) → existing platform routing engine continues to own this
- ❌ BYOK for non-LLM connectors (Slack, Salesforce, etc.) → already covered by `sdk-connectors` credential model, no new work needed
- ❌ Customer-facing dashboard of token usage by their provider invoice — covered by existing `sdk-meter` showback
- ❌ Automatic key rotation on schedule — manual rotation only in this phase; cron-driven rotation in a later phase

---

## 11 · Risks

| # | Risk | Severity | Likelihood | Mitigation |
|---|---|---|---|---|
| R-1 | A tenant binds an invalid / expired key; their completions silently fall through to platform and they get billed for tokens they thought were on their account | H | M | At bind time, run a synthetic `models.list` ping against the provider with the new key; refuse the bind if the ping fails. UI surfaces the failure. |
| R-2 | A tenant revokes their key mid-completion; the in-flight completion fails with `provider_unauthorized` | M | M | Gateway catches `401/403` from the provider, transparently retries once with the next credential in resolution order (platform fallback). Logged as a fallback event. |
| R-3 | Vault unwrap latency adds >2 ms p99 to the completion hot path | M | L | Cache unwrapped credentials in-process for 60 s keyed by `(tenant_id, provider_id)`; invalidate on bind/rotate/revoke event consumption |
| R-4 | A tenant's provider account has different model availability than ours; requests for models we route to fail | M | H | Surface `model_allowlist` in the UI as a recommendation; document common provider tier gaps. Long-term: discover available models from the provider at bind time. |
| R-5 | Audit event volume on revoke storms (chaos test, mass off-boarding) | L | L | Audit ledger already handles batch appends; chaos test in AC-6 |

---

## 12 · Rollout plan

1. **Week 1 dev** (internal alpha): schema + resolver + write endpoints + audit events behind feature flag `AI_GATEWAY_TENANT_BYOK_ENABLED=true`. Internal-tenant smoke test only.
2. **Week 1 end (staging)**: enable flag in staging; run AC-1..7 integration tests. Security WG review of AC-3 evidence.
3. **Week 2 start (limited prod)**: enable for two design-partner tenants (pre-arranged regulated buyers). Watch meter + audit + latency dashboards for 48 h.
4. **Week 2 mid (per-region)**: enable in primary US region, then EU region, then sovereign regions on staggered 24 h cadence.
5. **Week 2 end (GA)**: flip flag default-on globally; update public pricing page to remove "coming soon" badge; announce in customer release notes + changelog.

---

## 13 · Open questions / decisions needed

- [ ] Q-1: Should we validate the raw key at bind time with a real provider call, or trust the tenant? (R-1 mitigation choice — recommendation: **validate**, since the failure mode is silent over-billing.)
- [ ] Q-2: When a tenant credential exists but is invalid at runtime, do we fall back to platform credential (with audit event) or fail closed? Recommendation: **fail closed** for regulated tenants, **fallback** for standard tenants — selectable per binding via a `fallback_on_error` boolean.
- [ ] Q-3: Do we need a separate write-only API key (M2M) for binding credentials, or is tenant-admin JWT sufficient? Recommendation: **JWT-only** for v1; if customers ask for M2M, add in a follow-up.
- [ ] Q-4: Should the `last_4` actually be `last_4` or `last_8`? OpenAI keys are long; `last_8` may be friendlier. Decide before UI implementation.
- [ ] Q-5: Tenant uses BYOK; one model in their account is rate-limited. Do we observe and surface that to their `/ai/providers` page? Out-of-scope for v1, but worth scoping a follow-up.

---

## 14 · Sign-off

| Role | Name | Date | Status |
|---|---|---|---|
| Phase DRI (AI Gateway Lead) | | | |
| Platform Architect | | | |
| Security / Compliance WG | | | |
| Billing Lead | | | |
| Tenant Product Lead | | | |
| Engineering Lead | | | |
