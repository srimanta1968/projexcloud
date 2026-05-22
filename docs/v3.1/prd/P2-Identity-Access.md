# PRD · P2 — Identity & Access at Scale

| Field | Value |
|---|---|
| **Phase** | P2 |
| **Window** | Weeks 9–15 (~6 weeks) |
| **Maps to wave(s)** | W2 |
| **Gates closed** | G4 (Identity Projection System) |
| **Status** | DRAFT |
| **Owner (DRI)** | Identity Working Group lead |
| **Companion docs** | `../docs/v3.1/AIM-Identity-Model-v3.1.html` · `../docs/v3.1/SDK-Build-Plan-v3.1.html` §W2 · `../docs/v3.1/Architecture-v3.1.html` §7 · §11 |

---

## 1 · TL;DR

P2 makes **six-layer identity work at hyperscale**: tenant registry with the full extended hierarchy (reseller · sub-tenant · BU recursion · geo nodes · role templates · fiscal periods), JWT mint with the full six-layer claim set, consent receipts keyed by canonical `person_id`, ABAC policy with Identity Query Language, ReBAC with computational safeguards, end-customer API keys, and — critically — the **Identity Projection System** that turns six-layer resolution from a runtime graph walk into a sub-ms cached read. Without P2 + the projection, every P3+ SDK takes the bottleneck.

---

## 2 · Why this phase now

P1 gave us encrypted, audited, pool-routed, metered substrate. P2 turns that substrate into a multi-tenant identity system. Architectural review (Analyze2.txt #1) called runtime identity resolution at PB scale "the platform's first bottleneck" — it must become projected/cached. If we ship P3 SDKs (Profile · Persona · DSAR) before the Identity Projection exists, resolver becomes a runtime graph walk and you can't retrofit projection without re-instrumenting every P3 SDK. G4 must close in P2.

Within P2: Tenant must precede Identity (JWTs carry the full scope claim including pool indices). Identity must precede Consent (receipts key by `person_id`). Identity + Tenant must precede Policy + ReBAC (both read attributes from MDM). Skip any one and the others break.

---

## 3 · What ships in this phase

| Component | Type | Effort | Owner | Notes |
|---|---|---|---|---|
| `@projexlight/sdk-tenant` | SDK · NEW (extended in v3.1) | L · 5w | Identity WG | Registry for `org_id · app_id · tenant_id · bu_id`; isolation tiers (S/P/G); `admin_pool_index` + `app_pool_index{}` provisioning; emits `tenant.pool.assigned.v1`; **v3.1 extensions**: Reseller as first-class entity (commission + white-label + scoped admin); recursive sub-tenant (`parent_tenant_id`) with hybrid pool placement policy; recursive BU (`parent_bu_id`); GeographicNode tree (Region→Country→State→City→Locality); RoleTemplate registry with inheritance; FiscalPeriod per-tenant |
| `@projexlight/sdk-identity` | SDK · NEW (extended in v3.1) | L · 6w | Identity | OIDC server; credentials store (vaulted); MDM alias graph → canonical `person_id`; JWT mint with full six-layer tuple; first per-app login mints App Identity (L2); encounter-aware token issuance; MFA; session. **v3.1 extensions**: SAML 2.0 SP + SCIM 2.0 federation for enterprise IdPs (Okta · Azure AD · Ping · Google · Auth0); social IdP federation; **tenant impersonation for support** (scoped, time-bounded, consent + approval gated, audit-loud) |
| `@projexlight/sdk-consent` | SDK · NEW | M · 4w | Privacy | Consent receipts keyed by `(person_id, purpose, processor, app_id, jurisdiction)`; revocation log; offline-grant replay queue (used by HDK in P3); purpose registry; cross-border policy hook; cross-tenant consent receipts (source + target tenant memberships) |
| `@projexlight/sdk-policy` | SDK · NEW (extended in v3.1) | L · 5w | Identity | ABAC policy evaluator (Cedar/OPA-style); attribute fetchers backed by MDM; per-service guard middleware; decision log → Audit; six-layer attribute fetchers; pool-aware rule type. **v3.1 extensions**: **Identity Query Language (IQL)** — typed DSL `subject.persona(role="doctor") · relationship(type="care-team") · encounter(active=true)` compiled to Cedar term; **policy precomputation** (hot decisions cached against versioned subject snapshot) |
| `@projexlight/sdk-rebac` | SDK · NEW (extended in v3.1) | L · 5w | Identity | Relationship graph store; ReBAC policy evaluator; cross-tenant relationship coordinator; relationship lifecycle (open · active · suspended · terminated); decision log → Audit; relationship re-attestation cadence. **v3.1 safeguards** (Analyze2 #3): `ReBACTraversalBudget` (depth cap default 4); relationship TTL with auto-expiry; edge indexes (kind + persona_a + persona_b); graph caching; async graph projection precomputes reachability off the hot path |
| `@projexlight/sdk-api-keys` | SDK · NEW | M · 3w | Identity | End-customer programmatic-access keys (distinct from human OIDC); per-key typed scopes; per-key rate limits (composes with sdk-meter); rotation; revocation; last-used telemetry; prefix-style visualization; revoke-all on tenant offboarding |
| **`sdk-identity-resolver` Identity Projection System** | Background worker · NEW | M · 3w | Identity | The strategic G4 closer. Subscribes to relationship/consent/policy/membership change events; materializes flattened `subject_view` per `(person, app, tenant)` into Redis (hot) + Postgres (durable); resolver reads projection first, falls back to live resolve only on miss. Note: `sdk-identity-resolver` itself ships in P3; in P2 we deliver the **projector worker** and the `subject_view` schema in contracts so projection writes start happening in week 12+ |
| `services/identity-service` | Service · NEW | M · 4w | Identity | OIDC server runtime + SAML SP + SCIM endpoint + tenant impersonation flows |
| `services/identity-projector` | Service · NEW | M · 3w | Identity | Background worker maintaining `subject_view` projections |

---

## 4 · User stories

### As a **Platform Engineer**
- **US-PE-1**: I issue a JWT for a test user and the token carries the full six-layer claim set (`org_id · app_id · tenant_id · bu_id · person_id · primary_persona_id` + encounter_id when applicable) — every downstream SDK can read these without round-trips.
- **US-PE-2**: I call `resolveIdentityContext(token)` (delivered as the public read API in P3) and it reads from the Identity Projection store in <1ms warm — no six-layer graph walk on the hot path.
- **US-PE-3**: I write a policy in IQL — `subject.persona(role="senior_doctor") and relationship(type="care-team", target=encounter.patient)` — and it compiles to a Cedar policy term that evaluates against the projection.

### As a **ProjexCloud Operator**
- **US-OP-1**: I provision a reseller with 50 customer tenants and consolidated billing addressed to the reseller; the reseller admin can see (read-mostly) into every customer tenant they manage.
- **US-OP-2**: I create a sub-tenant under a parent tenant ("Flagship Hospital" under "Healthcare HIE Network") — by default it shares the parent's pool; I can opt the sub-tenant up to Tier-P for dedicated isolation.
- **US-OP-3**: I run a tenant impersonation session for a support ticket — system requires my manager's approval AND the customer's consent; every action under impersonation is loudly audited with a red banner in the customer's audit log.

### As a **Tenant Admin**
- **US-TA-1**: I connect my company's Okta org as the identity source for my tenant; SCIM provisions employees automatically; group → role-template mapping happens at JIT login.
- **US-TA-2**: I create an API key with scopes `["crm.read", "engagement.encounter.create"]` and a 90-day TTL for our Zapier integration; I can see last-used timestamp and revoke instantly.
- **US-TA-3**: I create a BU tree (Global → Regional → Country → Site → Department) and assign role templates; policy inheritance cascades automatically — no per-row policy edit.
- **US-TA-4**: I configure my fiscal year to end March 31 with USD as base currency; billing and analytics align to my fiscal calendar.

### As a **Tenant Employee** (clinician at a healthcare network)
- **US-EU-1**: I'm a senior doctor at "Flagship Hospital" (sub-tenant of "Healthcare HIE"); I can see patients across the network where I have a care-team relationship; I cannot see other hospitals' patients without an explicit relationship.
- **US-EU-2**: When I'm promoted from senior_doctor to chief_of_medicine, my access widens within the next 1s (projection refresh) — I don't have to log out.

### As a **Security / Compliance Lead**
- **US-SC-1**: I run a 10M-edge ReBAC load test; authorization decisions stay p99 ≤ 5ms with traversal budget enforced.
- **US-SC-2**: I revoke a PCP relationship; within 1s the projection is refreshed and the doctor's chart-read attempts are denied with an audited reason.

---

## 5 · Functional requirements (per SDK / component)

### 5.1 · `@projexlight/sdk-tenant`

**Purpose:** The registry for org / tenant / sub-tenant / BU hierarchy + the new v3.1 first-class entities.

**Owns:**
- FR-TNT-1: Tenant CRUD with isolation tier (S/P/G), region pin, brand/domain routing
- FR-TNT-2: Reseller as first-class entity — `reseller_id`, commission rules, white-label config (brand override · CNAME · support contact), portfolio kill switches, invoice-aggregation preference
- FR-TNT-3: Recursive sub-tenant — `parent_tenant_id`; audit roll-up via CTE traversal; quota inheritance with explicit override
- FR-TNT-4: Hybrid sub-tenant pool placement policy — share parent's pool by default; opt-out to Tier-P/G for dedicated isolation
- FR-TNT-5: Recursive BU — `parent_bu_id`; ABAC policy inheritance cascades; IQL exposes `subject.bu.ancestors()`
- FR-TNT-6: GeographicNode tree in `@projexlight/contracts` (Region → Country → State → City → Locality) + Global Catalog placement (read-replicated)
- FR-TNT-7: Role-template registry per app with inheritance (junior < senior < chief); per-tenant overrides
- FR-TNT-8: Fiscal period per tenant (Year/Quarter/Month/Week with custom fiscal-year-start)
- FR-TNT-9: Provisions `admin_pool_index` + `app_pool_index{}` at tenant creation; emits `tenant.pool.assigned.v1`
- FR-TNT-10: Module subscription matrix (which verticals the tenant has access to)

**Public API surface (selected):**
```ts
export async function createTenant(input: CreateTenantInput): Promise<Tenant>;
export async function attachReseller(tenant_id: string, reseller_id: string, terms: ResellerTerms): Promise<void>;
export async function createSubTenant(parent_tenant_id: string, input: CreateTenantInput, placement?: 'share' | 'tier-p' | 'tier-g'): Promise<Tenant>;
export async function createBU(tenant_id: string, parent_bu_id: string | null, input: BUInput): Promise<BU>;
export async function setFiscalCalendar(tenant_id: string, input: FiscalCalendar): Promise<void>;
```

**Database / storage:** `tenant` schema in Admin Pool (reseller, tenant, sub-tenant, BU, geo refs, roles, fiscal). GeographicNode in Global Catalog.

**Events published:** `tenant.created.v1` · `tenant.pool.assigned.v1` · `tenant.subtenant.created.v1` · `reseller.tenant.attached.v1` · `tenant.bu.created.v1` · `tenant.bu.moved.v1` · `tenant.role-template.updated.v1` · `tenant.fiscal-calendar.updated.v1`

**Pool placement:** Admin Pool (per region).

**SKUs:** `tenant.create` · `tenant.update` · `tenant.subtenant.create` · `tenant.bu.create` · `reseller.attach` — `flat_per_call`.

### 5.2 · `@projexlight/sdk-identity`

**Purpose:** Authentication + canonical identity resolution + MDM alias graph.

**Owns:**
- FR-IDN-1: OIDC server with standard discovery, JWKS, userinfo endpoints
- FR-IDN-2: Credentials store with vaulted secrets (passwords hashed + per-tenant pepper; never plaintext)
- FR-IDN-3: MDM alias graph (email · phone · biometric · gov-IDs → canonical `person_id`)
- FR-IDN-4: JWT mint with full six-layer claim set + pool indices + projection version
- FR-IDN-5: First per-app login auto-mints App Identity (L2) via the persona service hook
- FR-IDN-6: MFA (TOTP · WebAuthn · SMS) per-tenant policy
- FR-IDN-7: Session management with sliding TTL + hard expiry
- FR-IDN-8: SAML 2.0 SP for federated IdPs; per-tenant federation config
- FR-IDN-9: SCIM 2.0 endpoint for JIT user provisioning + deprovisioning
- FR-IDN-10: Social IdP federation (Google · Apple · Microsoft) for B2C verticals
- FR-IDN-11: Tenant impersonation request → approval → time-bounded JWT (with `actor.kind='support_impersonator'` claim, audit-loud)

**Database / storage:** `identity` schema in Admin Pool (credentials, alias graph, federation config, session); JWKS in Vault.

**Events published:** `identity.login.v1` · `identity.app-identity.created.v1` · `identity.alias.merged.v1` · `identity.federation.configured.v1` · `identity.impersonation.granted.v1` · `identity.impersonation.ended.v1`

**Pool placement:** Admin Pool. Person home region pin.

**SKUs:** `identity.jwt.mint` · `identity.jwt.verify` · `identity.mdm.merge` · `identity.mfa.challenge` · `identity.impersonation.request` — `tiered_per_call` (high-volume `verify`; lower-volume `mint`).

### 5.3 · `@projexlight/sdk-consent`

**Purpose:** Consent receipts keyed by canonical `person_id`, with cross-border + cross-tenant support.

**Owns:**
- FR-CNS-1: Receipt store keyed by `(person_id, purpose, processor, app_id, jurisdiction)`
- FR-CNS-2: Revocation log (every revoke recorded with timestamp + actor + reason)
- FR-CNS-3: Offline-grant replay queue (HDK records consent offline; replays on reconnect — used in P3)
- FR-CNS-4: Purpose registry (typed list of purposes per app)
- FR-CNS-5: Cross-border policy enforcement hook (e.g., EU resident's data cannot be processed in non-adequate jurisdiction without explicit purpose)
- FR-CNS-6: Cross-tenant consent receipts (source + target tenant memberships) for referral / handoff scenarios

**Database / storage:** `consent` schema in Admin Pool (receipts) + per-tenant cross-tenant index.

**Events published:** `consent.granted.v1` · `consent.revoked.v1` · `consent.purpose.registered.v1` · `consent.cross-tenant.granted.v1`

**Pool placement:** Admin Pool (person's home region).

**SKUs:** `consent.grant` · `consent.revoke` · `consent.check` · `consent.export` — `flat_per_call`.

### 5.4 · `@projexlight/sdk-policy`

**Purpose:** ABAC policy evaluator with IQL grammar + precomputation.

**Owns:**
- FR-POL-1: Cedar-style policy evaluator with attribute fetchers backed by MDM
- FR-POL-2: Per-service guard middleware (`requirePolicy(policy_id)` decorator)
- FR-POL-3: Decision log writes to Audit (allow/deny + reason + version)
- FR-POL-4: Policy versioning (semver per policy bundle)
- FR-POL-5: Six-layer attribute fetchers
- FR-POL-6: Pool-aware rule type ("actor and target must be in the same pool")
- FR-POL-7: Identity Query Language — typed DSL with parser, AST, evaluator
- FR-POL-8: Syntax-highlighter + auto-completion for policy authoring UI
- FR-POL-9: Policy precomputation — hot decisions cached against `projection_version` (cache key); invalidates on relationship/consent/policy change

**Public API surface (selected):**
```ts
export type IQLExpression = 
  | { subject: 'persona', filter: { role: string } }
  | { relationship: { type: string, target?: string } }
  | { encounter: { active?: boolean } };

export async function evaluate(
  policy_id: string,
  context: IdentityContext,
  target?: ResourceContext
): Promise<{ decision: 'ALLOW' | 'DENY'; reason: string; layers_used: string[] }>;

export function compileIQL(expr: string): CompiledPolicy;
```

**Database / storage:** `policy` schema in Admin Pool (policies per tenant); Redis precomp cache distributed.

**Events published:** `policy.evaluated.v1` (sampled · operational retention) · `policy.updated.v1` (regulated)

**Pool placement:** Admin Pool (per-tenant).

**SKUs:** `policy.evaluate` · `policy.update` · `policy.iql.compile` — `flat_per_call` (very cheap; usually rolled into the consuming SDK's invoice).

### 5.5 · `@projexlight/sdk-rebac`

**Purpose:** Relationship-Based Access Control with computational safeguards.

**Owns:**
- FR-REB-1: Typed relationship graph store (`relationship_id · kind · persona_a · persona_b · scope · status · expires_at · consent_ref`)
- FR-REB-2: ReBAC evaluator (allows access based on relationship existence + scope + status)
- FR-REB-3: Cross-tenant relationship coordinator (special re-encryption key tier)
- FR-REB-4: Relationship lifecycle (open · active · suspended · terminated · expired)
- FR-REB-5: Relationship re-attestation cadence (e.g., healthcare PCP annual re-attest)
- FR-REB-6: `ReBACTraversalBudget` — depth cap (default 4), node-visit count cap per decision
- FR-REB-7: Edge indexes (kind + persona_a + persona_b) for sub-ms lookups
- FR-REB-8: Graph caching keyed by (subject, target, scope); invalidation on relationship change
- FR-REB-9: Async graph projection precomputes "all personas reachable from X via care-team within 2 hops"
- FR-REB-10: Decision log → Audit

**Database / storage:** `rebac` schema in App Pool (for in-app relationships) + Admin Pool (cross-tenant relationships); Redis for the projection cache.

**Events published:** `rebac.relationship.created.v1` · `rebac.relationship.scope.changed.v1` · `rebac.relationship.terminated.v1` · `rebac.decision.v1` (sampled)

**Pool placement:** App Pool (in-app) + Admin Pool (cross-tenant).

**SKUs:** `rebac.relationship.create` · `rebac.check` · `rebac.scope.update` — `flat_per_call`.

### 5.6 · `@projexlight/sdk-api-keys`

**Purpose:** End-customer programmatic-access keys distinct from human OIDC sessions.

**Owns:**
- FR-APK-1: API key generation with typed scopes (e.g., `["crm.contact.read", "engagement.encounter.create"]`)
- FR-APK-2: Hash-at-rest (PBKDF2 / Argon2); only prefix visible in UI (`pk_live_abc...xyz`)
- FR-APK-3: Per-key rate limits (composes with sdk-meter)
- FR-APK-4: Rotation with grace window (old key valid for 24h post-rotate by default)
- FR-APK-5: Revocation (immediate; broadcasts to gateway within 1s)
- FR-APK-6: Last-used telemetry per key
- FR-APK-7: Webhook on rotation (composes with sdk-webhook in P4)
- FR-APK-8: Revoke-all on tenant offboarding (composes with sdk-tenant-lifecycle in P4)
- FR-APK-9: Each key bound to a synthetic persona so audit + ReBAC behave consistently

**Database / storage:** `api_keys` schema in Admin Pool (hashed key + scope + metadata).

**Events published:** `api-key.issued.v1` · `api-key.rotated.v1` · `api-key.revoked.v1` · `api-key.used.v1` (sampled)

**Pool placement:** Admin Pool.

**SKUs:** `api-key.issue` · `api-key.rotate` · `api-key.revoke` — `flat_per_call`.

### 5.7 · Identity Projection System (background worker in `sdk-identity-resolver`)

**Purpose:** Close G4 — precomputed flattened `subject_view` per `(person, app, tenant)` so the hot path is a Redis read, not a six-layer graph walk.

**Owns:**
- FR-IPS-1: `subject_view` table schema (see AIM §2B.1) in Admin Pool of person's home region
- FR-IPS-2: Subscribes to: `identity.persona.created.v1` · `identity.persona.shred.v1` · `identity.membership.*` · `identity.role.*` · `rebac.relationship.*` · `consent.granted.v1` · `consent.revoked.v1` · `tenant.bu.moved.v1` · `tenant.role-template.updated.v1`
- FR-IPS-3: On any triggering event, recomputes the affected `subject_view` row within 1s and pushes to Redis
- FR-IPS-4: TTL re-projection (1h default) as safety re-projection
- FR-IPS-5: Atomic Postgres + Redis write with pub/sub invalidate fan-out
- FR-IPS-6: `projection_version` monotonic counter on every refresh (used by policy precomputation cache)
- FR-IPS-7: Fallback to live six-layer resolve on cache+DB miss; emits alert

**Database / storage:** `projection` schema in Admin Pool (durable) + Redis per region (hot).

**Events published:** `identity.projection.refreshed.v1` (operational, sampled) · `identity.projection.miss.v1` (operational)

**Pool placement:** Admin Pool of person's home region; Redis per region.

**SKUs:** None — internal infrastructure.

---

## 6 · Non-functional requirements

| Dimension | Target |
|---|---|
| JWT mint latency (p99) | ≤ 50ms |
| JWT verify latency (p99) | ≤ 5ms |
| Identity Projection refresh latency (event → projection visible) | ≤ 1s p99 |
| Identity Projection read (warm Redis hit) | ≤ 0.5ms p99 |
| ReBAC decision (10M-edge graph, safeguards on) | ≤ 5ms p99 |
| Policy evaluate (Cedar + IQL) | ≤ 2ms p99 (cached) |
| SCIM provisioning latency (Okta → user creatable) | ≤ 10s |
| Pool quotas | 5k tenants per Admin Pool; ≤ 5TB |
| Compliance | GDPR · DPDP · HIPAA Tier P/G ready |

---

## 7 · Acceptance criteria (the phase exit gate)

These match `SDK-Build-Plan-v3.1.html §0A.4` for P2.

| # | Criterion | Owner | Test plan |
|---|---|---|---|
| **AC-1** | End-to-end: create org → app → tenant → bu; auto-assign pools; register person; issue JWT with full six-layer claim set | Identity WG | Integration test |
| **AC-2** | Deny/allow paths through Policy + ReBAC logged to Audit with reason | Identity | Integration test |
| **AC-3** | Consent grant + revoke + offline replay verified | Privacy | Integration test |
| **AC-4** | Reseller → sub-tenant chain: audit rolls through parent chain | Identity WG | Integration test |
| **AC-5** | Recursive BU inheritance verified — promotion of a BU's role-template cascades to children | Identity | Integration test |
| **AC-6** | Geographic-node sub-regional residency enforced (DE-only data stays in DE pool even within EU region) | Platform | Multi-region integration test |
| **AC-7** | Role-template inheritance respected by ABAC (senior_doctor inherits junior_doctor's permissions) | Identity | Policy evaluation test |
| **AC-8** | IQL parses and evaluates the canonical examples (`subject.persona(role="doctor") · relationship(type="care-team") · encounter(active=true)`) | Identity | Parser + evaluator unit + integration tests |
| **AC-9** | ReBAC 10M-edge load test passes p99 ≤ 5ms with safeguards active | Identity | Load test (k6 + synthetic graph) |
| **AC-10** | Relationship-revoke invalidates ReBAC cache fan-out < 1s | Identity | Chaos drill |
| **AC-11** | API key with limited scope can call only its scoped methods; out-of-scope call denied with audited reason | Identity | Integration test |
| **AC-12** | SAML + SCIM JIT-provisioning round-trips with Okta sandbox | Identity | Vendor sandbox integration |
| **AC-13** | Tenant impersonation: requires manager approval AND customer consent; every action audit-loud (red banner) in customer's read API | Identity | End-to-end scenario test |
| **AC-14** | **Identity Projection refresh** within 1s of any relationship/consent/policy change | Identity | Chaos drill — relationship revoked, projection observed |
| **AC-15** | Projection store stays under 50GB Postgres + 10GB Redis hot set at 10M subjects | Identity | Synthetic-scale test |
| **AC-16** | Chaos-killing the projector: fallback to live resolve works without errors (alert fires) | Identity | Chaos drill |
| **AC-17** | All P2 SDKs published as v1.0.0 to private registry | Platform | `npm view` checks |

---

## 8 · Test plan (per acceptance criterion)

### AC-1 · End-to-end identity bootstrap

**Scenario:** Run the integration suite that:
1. Creates org `org_test` via sdk-tenant
2. Creates app `app_test_healthcare` under that org
3. Creates tenant `ten_hospA` under app + creates one sub-tenant `ten_hospA_west`
4. Creates BU tree `Global → Region-West → Site-West-1`
5. Provisions `pers_alice` via sdk-identity (login flow)
6. Issues JWT for alice as Patient persona at ten_hospA

**Pass condition:** JWT contains `org_id · app_id · tenant_id · bu_id · person_id · primary_persona_id · admin_pool_index · app_pool_index`. Token decodable; signature verifies; expiry honored.

### AC-9 · ReBAC 10M-edge load test

**Scenario:** Pre-load `rebac` schema with 10M synthetic relationships across 100k personas. Run 1k req/s of ReBAC decisions across random subject/target pairs for 5 minutes.

**Pass condition:** p99 ≤ 5ms; no traversal exceeds depth cap; cache hit rate > 80% after warm-up; no OOM in the evaluator.

### AC-14 · Identity Projection freshness

**Scenario:**
- Given: alice has a PCP relationship with Dr. Smith at Hospital A; projection shows `effective_role_closure` includes `pcp_care_team_member`
- When: PCP relationship terminated via sdk-rebac
- Then: within 1s, projection `effective_role_closure` no longer includes the role; next chart-read by Dr. Smith for alice returns DENY with audited reason

**Pass condition:** Time from `rebac.relationship.terminated.v1` to projection refresh ≤ 1s p99 over 1000 trials.

### AC-15 · Projection store storage budget

**Scenario:** Generate 10M `(person, app, tenant)` triples (realistic distribution: 5M persons × avg 2 apps × avg 1 tenant per app). Run projector to materialize all. Measure Postgres `projection` schema size + Redis hot set.

**Pass condition:** Postgres ≤ 50GB, Redis ≤ 10GB.

### AC-13 · Tenant impersonation flow

**Scenario:**
1. Support engineer Priya requests impersonation of ten_test_001 for ticket SUP-998
2. Priya's manager (or auto-approver per support contract) approves
3. Customer's primary contact gets in-app notification + must approve
4. JWT minted with `actor.kind='support_impersonator'`, expires in 30min
5. Priya performs 3 read actions
6. Session ends; certificate of impersonation generated

**Pass condition:** Customer's audit-read API shows all 3 actions with red banner + `actor.real_user='usr_priya'`; certificate signed by sdk-audit; nothing logged after expiry.

(Other ACs follow analogous patterns — captured in engineering tickets.)

---

## 9 · Dependencies

- ✅ P1 exit gate green (every P1 AC verified)
- ✅ `@projexlight/contracts` v1.0 with all P2 type signatures stable
- ✅ Vault, Audit, Pool Router, Meter (emit-only) operational in dev region
- ✅ Working Group sign-off on six-layer JWT claim shape
- ✅ Okta sandbox tenant provisioned for SAML+SCIM integration tests

---

## 10 · Out of scope (deferred to later phases)

- ❌ `resolveIdentityContext()` public API — P3 (delivered as sdk-identity-resolver; in P2 we ship the projector worker + schema)
- ❌ Profile bands re-homed to L2 — P3
- ❌ Persona CRUD — P3
- ❌ Data Rights (DSAR) workflow — P3
- ❌ Pool federation runtime — P7 (hooks already shipped in P1)
- ❌ Hard meter caps — P7 (still emit-only in P2)

---

## 11 · Risks

| # | Risk | Severity | Likelihood | Mitigation |
|---|---|---|---|---|
| R-1 | Six-layer JWT becomes too large (>4KB) and breaks browser cookies / header limits | M | M | Trim claims to references; full projection lookup via resolver in P3; JWT carries IDs + version |
| R-2 | IQL grammar adopted by multiple teams before stabilized | H | M | Pre-RFC syntax review; freeze grammar in week 11; later grammar additions are minor versions only |
| R-3 | ReBAC projection lag during high-write workloads | H | M | Async projection has back-pressure; ReBAC decisions fall back to live evaluator (slower, still correct) when projection is stale |
| R-4 | Reseller white-label clashes with Tenant-Admin Portal isolation (multi-tenant SPA assumption) | M | L | Reseller admin gets a separate route in ProjexCloud Admin Portal, not tenant-admin; isolation preserved |
| R-5 | SAML federation per-tenant complexity (per-tenant metadata, certificate rotation) | M | M | Per-tenant federation config UI in Tenant Admin (P4); operator-managed metadata in P2; documented runbook |
| R-6 | Tenant impersonation abuse (support engineer overuse) | H | L | Manager approval required; customer consent required; audit-loud; quarterly review by compliance |
| R-7 | Identity Projection store grows unbounded | M | M | Per-(person,app,tenant) TTL; safety re-projection bounded; CI tests storage budget at 10M scale |

---

## 12 · Rollout plan

1. **Week 9–10**: sdk-tenant lands first (extended hierarchy types in contracts → DB migrations → API)
2. **Week 10–13**: sdk-identity track (OIDC server → JWT mint → SAML → SCIM → impersonation)
3. **Week 11–14**: Parallel tracks — Consent, Policy (with IQL), ReBAC (with safeguards), API Keys
4. **Week 12–14**: Identity Projector worker + `subject_view` schema
5. **Week 14**: 10M-edge ReBAC load test
6. **Week 14**: Projection refresh chaos drills
7. **Week 15**: Phase exit-gate review

---

## 13 · Open questions / decisions needed

- [ ] Q-1: JWT claim trimming policy (full vs reference-only) — finalize before week 12
- [ ] Q-2: ReBAC depth cap default — 4 proposed; confirm with security
- [ ] Q-3: Tenant impersonation default — require customer per-session consent, or standing contract-level consent? — recommend standing with per-session notification
- [ ] Q-4: SAML metadata rotation cadence — annual default; customer-overridable
- [ ] Q-5: Identity projection re-projection safety TTL — 1h default; confirm

---

## 14 · Sign-off

| Role | Name | Date | Status |
|---|---|---|---|
| Phase DRI | Identity WG lead | | |
| Platform Architect | Tanveer | | |
| Security / Compliance | | | |
| Identity Working Group | | | |
