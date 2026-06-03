# GitHub Issue Stub — Tenant-BYOK for AI Provider Keys

> Paste this into a new issue at https://github.com/srimanta1968/projexcloud/issues/new
> (or run `gh auth login` + ask Claude to recreate this issue via `gh issue create`).

---

**Title:** `Tenant-BYOK for AI provider keys (sdk-ai-gateway extension)`

**Labels:** `epic` · `sdk-ai-gateway` · `enhancement` · `security` · `priority:high`

---

## Summary

Add per-tenant LLM provider credentials to `sdk-ai-gateway` so regulated tenants can bring their own OpenAI / Anthropic / Bedrock / Gemini API keys. Today every tenant routes through one platform-level credential per provider (`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `AWS_BEDROCK_ACCESS_KEY`, `GEMINI_API_KEY` from `.env` → `ai_gateway.provider`). This issue tracks the work to add a tenant-scope credential layer with transparent fallthrough to platform credentials.

This is a fast-follow to P6A and the precondition for shipping the Pro/Enterprise pricing tier's "BYOK for AI keys" feature.

## Why now

1. **Pricing-page commitment.** The new public pricing surface lists BYOK for AI keys as a Pro/Enterprise differentiator. Without it, the page either lies or we lose the regulated-enterprise tier of leads.
2. **AI gateway COGS exposure.** Platform-key tenants on Frontier models consume tokens we eat-then-bill. Tenant-BYOK puts power users on their own provider invoice.
3. **Compliance ask.** SOC 2 / HIPAA / FedRAMP-Moderate auditors increasingly require customer-managed credentials for services that handle regulated content. We already meet this for encryption (CMEK via `sdk-vault` BYOK); the AI gateway is the last data-touching surface that doesn't.

## Design doc

Full PRD: [`docs/v3.1/prd/Tenant-BYOK-AI-Keys.md`](../prd/Tenant-BYOK-AI-Keys.md)

Covers: motivation, schema, resolver, write API, admin UI, meter switch, audit events, non-functional targets, acceptance criteria (AC-1..7), test plan, dependencies, out-of-scope, risks (R-1..5), rollout, open questions (Q-1..5).

## Scope

**In scope (this issue):**
- New table `ai_gateway.tenant_provider_credential` with RLS by `tenant_id`
- `loadProviderRow` resolver: tenant-first, platform-fallback
- Bind / rotate / revoke endpoints (`POST/PATCH/DELETE/GET /api/ai-gateway/tenant-credentials`)
- Tenant-admin UI page at `/ai/providers`
- Meter SKU switch (governance-only on BYOK; suppress token markup)
- Audit event contracts: `ai_gateway.tenant_credential.{bound,rotated,revoked}.v1`

**Out of scope (deferred):**
- Per-app or per-persona credential scoping
- Tenant-managed routing policy
- BYOK for non-LLM connectors (already covered by `sdk-connectors`)
- Automatic key rotation on schedule

## Projexlight tracking

- **Epic:** `76ec75df-cf40-4336-b591-42019674d864` — "Tenant-BYOK for AI Provider Keys"
- **Sprint:** `8ef1d09e-dd8e-4daf-8d03-54dcd9f812f8` — Quick Prototype Sprint

**Features (5):**
| Feature ID | Title |
|---|---|
| `3f71666d-2c3d-4398-8d9e-e40075119762` | Per-tenant credential schema and resolver |
| `4fd90c9b-ab74-41ae-a6f4-0cff5cb038c8` | Bind/rotate/revoke write API |
| `90243dbd-8903-46b4-b093-8001a98ea883` | Tenant Admin BYOK provider page |
| `bbc13bd1-d812-4e28-9bdc-2f8253bf8c22` | Meter SKU switch for BYOK completions |
| `82ff0b20-9add-4392-9a3e-1bbdf60ec388` | Audit event contracts and emission |

**Tasks (10):**
| Short ID | Type | Title |
|---|---|---|
| TK-3446 | database | Create migration for `ai_gateway.tenant_provider_credential` ✅ done |
| TK-3447 | backend | Update `loadProviderRow` resolver for tenant-first fallthrough |
| TK-3448 | api_endpoint | Implement `bindTenantCredential` service + POST endpoint |
| TK-3449 | api_endpoint | Implement `rotateTenantCredential` + PATCH endpoint |
| TK-3450 | api_endpoint | Implement `revokeTenantCredential` + DELETE endpoint |
| TK-3451 | api_endpoint | Implement `listTenantCredentials` + GET endpoint |
| TK-3452 | frontend | Build `/ai/providers` list view in tenant-admin |
| TK-3453 | frontend | Build bind/rotate/revoke modals in `/ai/providers` |
| TK-3454 | backend | Stamp `credential_source` on completion meter events and switch SKUs |
| TK-3455 | backend | Add tenant-credential audit event contracts |

## Acceptance criteria

The phase exits when AC-1..7 in the PRD are independently verified. Key items:

- [ ] **AC-1**: Bind / rotate / revoke flow end-to-end, every action emits a regulated-class audit event
- [ ] **AC-2**: Resolver: tenant credential preferred, platform fallback transparent
- [ ] **AC-3**: Raw key material never exposed after save (grep test across UI / GET / audit / DB dump returns 0 hits)
- [ ] **AC-4**: BYOK completion emits `ai-gateway.completion.governance` only, suppresses token SKUs
- [ ] **AC-5**: `model_allowlist` honored
- [ ] **AC-6**: Revoke fallthrough within 5s
- [ ] **AC-7**: Runbook + tenant-admin guide section published

## Rollout

Feature flag `AI_GATEWAY_TENANT_BYOK_ENABLED` gates the entire surface during week 1 (dev + staging). Week 2: 2 design-partner tenants in prod → staggered regional rollout → flag default-on globally + pricing page update.

## Risks

| # | Risk | Mitigation |
|---|---|---|
| R-1 | Invalid/expired key silently falls through; tenant gets billed on platform tokens | Synthetic `models.list` ping at bind time |
| R-2 | Mid-completion revoke causes 401 from provider | Catch + retry once with next credential |
| R-3 | Vault unwrap latency >2 ms | 60s in-process cache, invalidated on event |
| R-4 | Tenant provider account has different model availability | Surface allowlist, document gaps |

## References

- PRD: `docs/v3.1/prd/Tenant-BYOK-AI-Keys.md`
- Existing AI gateway: `packages/sdk-ai-gateway/src/services/credentialBootstrap.ts`
- CMEK BYOK reference impl: `packages/sdk-vault/src/services/byok/`, `apps/tenant-admin/src/app/byok/page.tsx`
- Companion: P6A PRD `docs/v3.1/prd/P6A-AI-Isolation-MCP.md`
