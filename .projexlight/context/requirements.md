# Requirements - Sprint 2

## Project: ProjexCloud

The single canonical architecture: a shared horizontal platform — services, agents, contracts, design system, native SDK ecosystem (HDK), and the AIM (Application & Identity Management) foundation — consumed by every vertical we build. Builds once. Multi-tenant. Multi-vertical. Multi-app. Multi-surface (web · mobile · kiosk). Petabyte-scale via pool-based horizontal scaling (no sharding). Identity expressed as a six-layer stack — Master Person · App Identity · Tenant Membership · Persona · Encounter · Relationship — encrypted end-to-end and governed by a three-evaluator access mesh.

## Sprint Overview

## Epics

### P10 · E4 — Fail-Closed PDP & Audited Break-Glass

Formalize fail-closed-on-evaluator-error for sensitive resource classes, short-TTL cached decisions for low-risk, and an explicit audited break-glass path via sdk-approval (scoped, time-bounded, certificate-of-action). Implements Architecture v3.2 §11A.6.

### P10 · E1 — Obligation-Based Authorization (Mask/Filter/TTL on Decisions)

Extend the access mesh so policy decisions return obligations (mask_fields, row_filter, audit_level, ttl_seconds), not just ALLOW/DENY. Server-side enforcement of masking/filtering; UI visibility becomes advisory only. Closes the field-leak risk (critique Scenario 7). Implements Architecture v3.2 §11A.3 + P16 + OC-11.

### P10 · E2 — Platform Principal Token (Minted, Audience-Bound Internal Identity)

Gateway mints a signed, short-TTL, audience-bound token from the resolved IdentityContext; downstream services verify it instead of trusting forwarded headers. Closes the confused-deputy class (Scenario 5). Implements Architecture v3.2 §11A.4 + P17.

### P10 · E3 — Consent-Gated Authorization (Purpose-Bound, Fail-Closed)

Wire sdk-consent receipts into the sdk-policy decision as a first-class purpose-gated input; missing/revoked receipt fails closed for purpose-bound resources. Includes the healthcare purpose taxonomy (HIPAA TPO + 42 CFR Part 2). Implements Architecture v3.2 §11A.5 + P18; Required for the healthcare vertical (§11A.10).

### P10 · E5 — Resource Ownership Registry (GitOps, No-Owner-No-Resource)

A platform.resource_registry where every infra resource carries owner/team/repo/terraform_module/cost_center/classification/expiry; GitOps reconciler quarantines orphan/expired resources; OC-12 lint blocks unregistered resources. Implements Architecture v3.2 §11A.8 + OC-12.

### P10 · E6 — Healthcare EMPI / Probabilistic MDM

Extend sdk-identity-resolver with probabilistic patient matching for multi-source data: confidence scores, POSSIBLY_SAME candidate links (never forced merges), sdk-approval-governed steward review, reversible merge/unmerge as compensating events, and match-quality calibration. Required for the healthcare vertical (Architecture v3.2 §11A.10).

### P10 · E7 — Non-Breaking Integration & Regression Hardening

Guarantee the P10 changes are additive and break no existing SDK/service: optional obligations/token, additive-only DB migrations, cross-SDK integration & regression suite, and a CI gate requiring full build + isolation/chaos suites green.

### P10 · E8 — Observability, Audit & Lineage Taxonomy + Telemetry Portal

Implement the critique's 8-type observability taxonomy over the existing audit/trace/lineage/meter spine: end-to-end OpenTelemetry tracing, Grafana/Prometheus dashboards, security detection over the SIEM forwarder, plus MDM and consent observability. Addresses Analyze2 §3.11 and Reality Report v2 §4.7.

### P10 · E9 — Principal Context Enrichment (Device Posture · Network Zone · Purpose)

Add device_trust, network_zone, and purpose as first-class context fields on the resolved principal so policy and consent can condition on them. Addresses Reality Report v2 §7.10; purpose feeds the E3 consent-gating decision input.

## Features

### Obligations on the policy decision (sdk-policy)

Add an optional obligations object to EvaluatePolicyResult: mask_fields[], row_filter{}, audit_level, ttl_seconds. Backward compatible — absent obligations = today's behavior.

**Acceptance Criteria:**
EvaluatePolicyResult carries an optional obligations object
Existing allow/deny callers compile and behave unchanged
Obligations are emitted in the DecisionRecord audit

### Server-side obligation enforcement helper

Shared library that applies mask_fields and row_filter to a result set before serialization, called by gateway and data-reading SDKs.

**Acceptance Criteria:**
Helper masks declared fields server-side
Helper injects row filters into queries/results
Helper is unit-tested against leak cases

### Candidate links (POSSIBLY_SAME) + confidence scoring

Represent uncertain matches as POSSIBLY_SAME candidate links with confidence and provenance — never a forced merge.

**Acceptance Criteria:**
Candidate links carry confidence + provenance
No automatic destructive merge occurs
Links queryable by confidence band

### Probabilistic matching engine

Add probabilistic matching over name/DOB/address/phone/external IDs alongside the existing deterministic resolver.

**Acceptance Criteria:**
Probabilistic matcher returns candidate matches
Deterministic path unchanged
Configurable match thresholds

### OC-11 lint rule + gateway/SDK wiring

Lint rule fails any governed-data handler that reads an obligation-bearing decision but serializes raw rows. Wire enforcement into api-gateway read paths.

**Acceptance Criteria:**
Lint flags raw serialization of obligation-bearing reads
Gateway applies obligations on governed reads
CI blocks on OC-11 violations

### Gateway principal-token minting

api-gateway mints a signed, audience-bound, short-TTL JWT from the resolved IdentityContext (sub, app_id, tenant_id, personas, scopes, aud, exp).

**Acceptance Criteria:**
Gateway issues a signed principal token post-auth
Token is audience-bound and short-TTL
Token claims derive only from verified IdentityContext

### Downstream token verification middleware

Shared middleware verifies iss/aud/exp/signature and rejects forwarded user headers as identity sources.

**Acceptance Criteria:**
Services verify token signature and claims
Forwarded identity headers are ignored
Invalid/expired tokens are rejected with audit

### Signing-key management & rotation (sdk-vault)

Principal-token signing keys are issued and rotated through sdk-vault; rotation does not invalidate in-flight short-TTL tokens.

**Acceptance Criteria:**
Signing key sourced from sdk-vault
Key rotation scheduled and audited
Rotation overlap honors token TTL

### Consent receipt as policy decision input

Pass active consent receipts + requested purpose into sdk-policy evaluation as a first-class input.

**Acceptance Criteria:**
Policy input includes purpose + consent receipts
Decision considers consent presence/expiry
Consent-derived denials carry reason=consent_absent

### Purpose-gated fail-closed enforcement

For purpose-bound resources, missing or revoked consent yields DENY (fail closed), with audited reason.

**Acceptance Criteria:**
Purpose-bound resource without consent denies
Revocation immediately affects decisions
All consent denials are audited

### Healthcare purpose taxonomy (HIPAA TPO + 42 CFR Part 2)

Register healthcare purpose codes (treatment/payment/operations/research/marketing) and 42 CFR Part 2 segmented-consent handling for substance-use records.

**Acceptance Criteria:**
TPO purpose codes registered
Part 2 segmented consent enforced
Marketing purpose denied for PHI without explicit consent

### Fail-closed PDP on evaluator error

On evaluator unavailability, sensitive-class access denies; low-risk classes may serve short-TTL cached decisions.

**Acceptance Criteria:**
Evaluator error denies sensitive access
Low-risk cached decisions bounded by TTL
Degraded decisions audited

### Audited break-glass via sdk-approval

Explicit emergency access path: scoped, time-bounded, approval-gated, certificate-of-action, fully audited.

**Acceptance Criteria:**
Break-glass requires sdk-approval grant
Access is scoped and time-bounded
Certificate-of-action + audit emitted

### resource_registry schema + read API (sdk-resource-registry)

Schema with owner/team/repo/terraform_module/cloud_account/cost_center/classification/network_zone/created_by/approved_by/expires_at; thin read API surfaces ownership to admin app.

**Acceptance Criteria:**
resource_registry table created (additive migration)
Read API returns ownership for a resource_id
Non-null owner + approved_by required

### GitOps reconciler + orphan quarantine + OC-12 lint

Terraform/OpenTofu state diff quarantines live-but-unregistered or past-expiry resources and raises ownership alerts; OC-12 lint blocks unregistered provisioning.

**Acceptance Criteria:**
Orphan/expired resources are quarantined
Ownership alert raised on violation
OC-12 lint blocks unregistered resources

### Steward review queue (sdk-approval-governed)

High-risk/ambiguous matches queue to a steward surface; stewards adjudicate via sdk-approval delegation.

**Acceptance Criteria:**
Ambiguous matches queue for stewardship
Steward decision recorded with reason
Delegation governed by sdk-approval

### Reversible merge/unmerge as compensating events

Merges and unmerges are event-sourced and reversible; no destructive deletes.

**Acceptance Criteria:**
Merge emits a reversible event
Unmerge emits a compensating event
Full history preserved + auditable

### Match-quality calibration & monitoring

Track match precision/recall and calibration (e.g., ECE); surface unresolved-identity and merge-reversal metrics.

**Acceptance Criteria:**
Calibration metric computed and surfaced
Unresolved/merge-reversal metrics exposed
Threshold drift alerts emitted

### Additive-only contracts & migrations (back-compat)

Ensure obligations/token/consent-input are optional in @projexlight/contracts and all DB migrations are additive; no breaking schema changes.

**Acceptance Criteria:**
New contract fields are optional/additive
Migrations are additive-only (no drops/renames)
Existing consumers compile unchanged

### Cross-SDK integration & regression suite

Integration tests across identity-resolver → policy(+obligations) → consent → gateway(token) → audit, asserting no regression in existing flows.

**Acceptance Criteria:**
End-to-end happy-path test green
Pre-P10 behavior preserved where obligations absent
Cross-tenant isolation tests still pass

### CI gate: full build + isolation/chaos suites green

CI requires pnpm -w build plus the agent-isolation/chaos suites to pass before P10 changes merge.

**Acceptance Criteria:**
CI runs full workspace build
Isolation/chaos suites execute and pass
Merge blocked on red

### End-to-end OTel tracing (frontend -> gateway -> policy -> MDM -> DB)

Instrument OpenTelemetry spans across the full request path and propagate trace context through policy/MDM/consent calls.

**Acceptance Criteria:**
Single trace spans frontend->gateway->policy->MDM->DB
Trace context propagated across SDK calls

### Grafana/Prometheus dashboards by observability taxonomy

Prometheus exporters + Grafana dashboards organized by the 8 observability types (infra, service, security, data, MDM, policy, consent, audit).

**Acceptance Criteria:**
Prometheus metrics exported
Dashboards grouped by taxonomy

### Security observability + detection rules over SIEM forwarder

Detection rules over audit/trace streams (auth failures, privilege change, suspicious access) routed to SIEM/XDR via the existing vault SIEM forwarder.

**Acceptance Criteria:**
Detection rules defined
Alerts routed to SIEM/XDR

### MDM + consent observability metrics

Surface MDM observability (match confidence, unresolved identities, merge reversals) and consent observability (consent checked, purpose, receipt id).

**Acceptance Criteria:**
MDM match/unresolved/reversal metrics exposed
Consent decision metrics exposed

### Add device_trust + network_zone to principal context

Add device_trust and network_zone as first-class fields on IdentityContext/principal; capture them at the gateway.

**Acceptance Criteria:**
Fields present on principal
Captured at gateway, additive/optional

### Propagate purpose into decision context

Thread requested purpose through to the policy/consent decision input (consumed by E3 consent-gating).

**Acceptance Criteria:**
Purpose available to policy + consent
Backward compatible when absent

## Tasks

### Create resource_registry table (additive migration)

Schema: resource_id/type/environment/owner/team/repo/terraform_module/cloud_account/cost_center/data_classification/network_zone/created_by/approved_by/expires_at.

**Acceptance Criteria:**
- Additive migration
- owner + approved_by non-null

### POSSIBLY_SAME candidate-link model + confidence/provenance

Model uncertain matches as POSSIBLY_SAME links carrying confidence and provenance; never a forced merge.

**Acceptance Criteria:**
- Links carry confidence + provenance
- No auto destructive merge

### Verify migrations are additive-only (no drops/renames)

Audit all P10 DB migrations to be additive-only; no column drops/renames that break running services.

**Acceptance Criteria:**
- No destructive migrations
- Auto-migrate on deploy stays green

### Extend EvaluatePolicyResult with optional obligations

Add optional obligations { mask_fields[], row_filter{}, audit_level, ttl_seconds } to policy.model.ts EvaluatePolicyResult. Absent obligations must preserve today's allow/deny behavior exactly.

**Acceptance Criteria:**
- obligations is optional and additive
- allow/deny-only callers unchanged
- type exported from @projexlight/contracts

### Emit obligations into DecisionRecord audit

Persist the returned obligations on the DecisionRecord so policy observability can see mask/filter/audit_level/ttl per decision.

**Acceptance Criteria:**
- DecisionRecord stores obligations
- Audit query surfaces obligations

### Build obligation enforcement helper (mask + row_filter)

Shared library that applies mask_fields and row_filter to a result set before serialization; consumed by gateway and data-reading SDKs.

**Acceptance Criteria:**
- Masks declared fields server-side
- Injects row filters
- Pure + unit-testable

### Wire obligation enforcement into api-gateway read paths

api-gateway applies the enforcement helper on governed reads so masking/filtering happens centrally.

**Acceptance Criteria:**
- Gateway applies obligations on governed reads
- No regression for non-governed reads

### Mint signed audience-bound principal token at gateway

api-gateway mints a signed short-TTL JWT from the resolved IdentityContext (sub, app_id, tenant_id, personas, scopes, aud, exp) after authentication.

**Acceptance Criteria:**
- Signed token issued post-auth
- Audience-bound + short TTL

### Derive token claims from verified IdentityContext only

Token claims must come solely from the server-resolved IdentityContext, never from user-supplied input.

**Acceptance Criteria:**
- No user-supplied claim trusted

### Principal-token verification middleware (iss/aud/exp/sig)

Shared middleware verifying issuer, audience, expiry and signature for downstream services.

**Acceptance Criteria:**
- Verifies sig + claims
- Rejects invalid/expired with audit

### Reject forwarded identity headers as identity source

Services must ignore user-forwarded identity headers and trust only the verified principal token.

**Acceptance Criteria:**
- Forwarded identity headers ignored

### Source + rotate signing key via sdk-vault

Principal-token signing keys issued and rotated through sdk-vault.

**Acceptance Criteria:**
- Key from sdk-vault
- Rotation audited

### Honor TTL overlap during key rotation

Rotation must not invalidate in-flight short-TTL tokens (dual-key verification window).

**Acceptance Criteria:**
- In-flight tokens stay valid through rotation

### Add purpose + consent receipts to policy evaluation input

Pass requested purpose and active consent receipts into sdk-policy evaluation as a first-class input.

**Acceptance Criteria:**
- Input carries purpose + receipts
- Decision considers consent presence/expiry

### Set reason=consent_absent on consent-derived denials

Denials caused by missing/expired consent carry a distinct, auditable reason code.

**Acceptance Criteria:**
- Distinct reason code surfaced + audited

### Fail-closed deny for purpose-bound resource without consent

For purpose-bound resources, a missing/revoked receipt yields DENY (fail closed).

**Acceptance Criteria:**
- No consent -> deny for purpose-bound resource

### Propagate consent revocation into live decisions

Revoking consent immediately affects subsequent decisions.

**Acceptance Criteria:**
- Revocation reflected in next decision

### Register HIPAA TPO purpose codes

Register treatment/payment/operations/research/marketing purpose codes in sdk-consent.

**Acceptance Criteria:**
- TPO codes registered
- Marketing denied for PHI without explicit consent

### Enforce 42 CFR Part 2 segmented consent for substance-use records

Segmented-consent handling for Part 2 substance-use data, distinct from general PHI consent.

**Acceptance Criteria:**
- Part 2 records gated separately

### Fail-closed on evaluator error for sensitive classes

On policy evaluator unavailability, sensitive-class access denies.

**Acceptance Criteria:**
- Evaluator error -> deny sensitive
- Degraded decisions audited

### Short-TTL cached decisions for low-risk classes

Low-risk classes may serve bounded short-TTL cached decisions during evaluator outage.

**Acceptance Criteria:**
- Cache bounded by TTL

### Break-glass grant via sdk-approval (scoped, time-bounded)

Emergency access requires an sdk-approval grant; access is scoped and time-bounded.

**Acceptance Criteria:**
- Requires approval
- Scoped + time-bounded

### Emit certificate-of-action + audit on break-glass

Every break-glass use emits a certificate-of-action and full audit record.

**Acceptance Criteria:**
- Certificate + audit emitted

### GitOps reconciler: quarantine orphan/expired resources

Terraform/OpenTofu state diff quarantines live-but-unregistered or past-expiry resources and raises ownership alerts.

**Acceptance Criteria:**
- Orphan/expired quarantined
- Alert raised

### Probabilistic matcher over name/DOB/address/phone/ext-ID

Add probabilistic matching alongside the deterministic resolver for multi-source patient data.

**Acceptance Criteria:**
- Returns candidate matches
- Deterministic path unchanged

### Configurable thresholds; deterministic path unchanged

Match thresholds are configurable; deterministic resolution remains the default fast path.

**Acceptance Criteria:**
- Thresholds configurable

### Steward review queue surface

High-risk/ambiguous matches queue to a steward review surface.

**Acceptance Criteria:**
- Ambiguous matches queued

### Steward adjudication via sdk-approval delegation

Stewards adjudicate queued matches; delegation governed by sdk-approval; decision recorded with reason.

**Acceptance Criteria:**
- Decision recorded + reason
- Delegation via sdk-approval

### Merge as reversible event

Merging two records emits a reversible, event-sourced merge event (no destructive delete).

**Acceptance Criteria:**
- Merge emits reversible event

### Unmerge compensating event (no destructive delete)

Unmerge emits a compensating event restoring prior state; full history preserved.

**Acceptance Criteria:**
- Unmerge compensates
- History preserved + auditable

### Compute + surface calibration (ECE) metric

Compute expected-calibration-error and surface it for match quality.

**Acceptance Criteria:**
- ECE computed + surfaced

### Unresolved/merge-reversal metrics + drift alerts

Expose unresolved-identity and merge-reversal metrics; alert on threshold drift.

**Acceptance Criteria:**
- Metrics exposed
- Drift alerts emitted

### Instrument OTel spans across the request path

Add OpenTelemetry spans at frontend, gateway, policy, MDM and DB boundaries.

**Acceptance Criteria:**
- Spans emitted at each boundary

### Propagate trace context through policy/MDM/consent calls

Thread W3C trace context across internal SDK calls so one trace_id spans the path.

**Acceptance Criteria:**
- Single trace_id end-to-end

### Wire Prometheus metric exporters

Expose Prometheus metrics for infra/service/policy/consent/MDM/audit signals.

**Acceptance Criteria:**
- Metrics scrapeable by Prometheus

### Define security detection rules over audit/trace streams

Rules for auth failures, privilege change, suspicious access.

**Acceptance Criteria:**
- Detection rules defined

### Route detections to SIEM/XDR via vault forwarder

Reuse the existing vault SIEM forwarder to route detections to SIEM/XDR.

**Acceptance Criteria:**
- Detections routed to SIEM/XDR

### Expose MDM match-confidence/unresolved/reversal metrics

Surface EMPI observability: match confidence distribution, unresolved identities, merge reversals.

**Acceptance Criteria:**
- MDM metrics exposed

### Expose consent-checked/purpose/receipt metrics

Surface consent observability: consent checked, purpose, receipt id.

**Acceptance Criteria:**
- Consent decision metrics exposed

### Add device_trust + network_zone fields to principal

Add optional device_trust and network_zone fields to IdentityContext/principal (additive, backward compatible).

**Acceptance Criteria:**
- Fields optional/additive
- No change when absent

### Capture device posture + network zone at gateway

Populate device_trust and network_zone at the gateway during principal resolution.

**Acceptance Criteria:**
- Gateway populates fields

### Thread purpose through to policy/consent decision input

Make requested purpose available to policy and consent evaluation (consumed by E3 consent-gating).

**Acceptance Criteria:**
- Purpose available to policy + consent
- Backward compatible

### Resource-ownership read API (sdk-resource-registry)

Thin read API surfacing ownership for a resource_id to the admin app.

**Acceptance Criteria:**
- GET ownership by resource_id

### Query candidate links by confidence band

API to retrieve candidate links filtered by confidence band.

**Acceptance Criteria:**
- Filter by confidence band

### Unit tests for masking/row-filter leak cases

Test suite asserting masked fields never reach the wire and row filters are enforced even when callers forget to apply them.

**Acceptance Criteria:**
- Leak cases covered
- Row-filter bypass cases covered

### Cross-SDK e2e: resolver -> policy -> consent -> gateway -> audit

Integration test covering the full P10 path; asserts existing flows still pass.

**Acceptance Criteria:**
- End-to-end happy path green
- Cross-tenant isolation tests pass

### Assert pre-P10 behavior preserved when obligations absent

Regression test: with no obligations/consent-input/token, behavior matches pre-P10 exactly.

**Acceptance Criteria:**
- No behavior change when features unused

### CI gate: pnpm -w build

CI runs the full workspace build and blocks merge on failure.

**Acceptance Criteria:**
- Full build runs in CI
- Merge blocked on red

### CI gate: agent-isolation/chaos suites + block on red

CI runs the agent-isolation and chaos suites for the affected SDKs and blocks merge on failure.

**Acceptance Criteria:**
- Isolation/chaos suites run
- Merge blocked on red

### Add OC-11 lint rule for raw serialization of governed reads

Lint rule that fails any governed-data handler reading an obligation-bearing decision but serializing raw rows.

**Acceptance Criteria:**
- Lint flags raw serialization
- CI blocks on OC-11 violation

### OC-12 lint blocks unregistered provisioning

Lint/policy that blocks provisioning a resource without a registry row (no owner = no resource).

**Acceptance Criteria:**
- Unregistered provisioning blocked

### Make obligations/token/consent fields optional in contracts

Ensure new fields in @projexlight/contracts are optional/additive so existing consumers compile unchanged.

**Acceptance Criteria:**
- New fields optional/additive
- Existing consumers compile unchanged

### Build Grafana dashboards for the 8 observability types

Dashboards grouped by infra/service/security/data/MDM/policy/consent/audit.

**Acceptance Criteria:**
- Dashboards grouped by taxonomy

