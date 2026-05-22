# PRD · P3 — Canonical Entities + Privacy Ops + HDK Foundation

| Field | Value |
|---|---|
| **Phase** | P3 |
| **Window** | Weeks 15–22 (~7 weeks) |
| **Maps to wave(s)** | W3 (Canonical Extensions + Persona) + HDK foundations track |
| **Gates closed** | G5 (person_pool_residency) · G6 (Conflict Resolution Model + hdk-sync) |
| **Status** | DRAFT |
| **Owner (DRI)** | Identity WG (canonical entities) + Mobile lead (HDK) |
| **Companion docs** | `../docs/v3.1/AIM-Identity-Model-v3.1.html` · `../docs/v3.1/Architecture-v3.1.html` §6A (Conflict Resolution Model) · §8A (Pool Placement) |

---

## 1 · TL;DR

P3 completes the **canonical entity layer** (Profile bands re-homed to App Identity, Persona with extensions, canonical addresses via Geo, canonical devices, feature flags) and lights up the **privacy operations** layer (Identity Resolver as the only sanctioned identity read entry point, Data Rights workflow with DSAR + erasure, person_pool_residency registry). It also kicks off the **HDK foundation** track: idp + permissions + diagnostic + the critical new `hdk-sync` module that owns the offline write queue and the Conflict Resolution Model — **hdk-sync MUST land before hdk-camera/map ship** so every later HDK module has a sanctioned offline-write owner.

---

## 2 · Why this phase now

With Identity + ABAC + ReBAC + Identity Projection live (P2), we can finally let domain SDKs read personal data — but only through the resolver, only with consent + ABAC clear, and only with the DSAR machinery in place to honor erasure requests. Without person_pool_residency (G5), DSAR cannot fan out — "I erased your data" becomes unverifiable across 200+ pools. Without hdk-sync + the Conflict Resolution Model (G6), every later HDK module (camera, map, scanner, …) hits unresolvable conflicts in production week 1.

---

## 3 · What ships in this phase

| Component | Type | Effort | Owner | Notes |
|---|---|---|---|---|
| `@projexlight/sdk-profile` | SDK · MODIFIED v3 | L · 5w | Identity | Four bands: Profile/Preference/Notification-routing now live on App Identity (L2 — per-app); Secure Data (DL · PAN · Aadhaar · SSN · Passport · PCI) stays on Master Person (L1) with per-field envelope encryption |
| `@projexlight/sdk-persona` | SDK · NEW v3 | L · 6w | Identity | App Identity (L2) CRUD; Tenant Membership (L3) CRUD; Persona (L4) CRUD; per-app role registry; multi-persona-per-membership; persona extension joins to app pools; persona shred independent of person shred; per-persona audit |
| `@projexlight/sdk-identity-resolver` | SDK · NEW v3.1 | M · 3w | Identity | The canonical `resolveIdentityContext(token)` entry point. Reads from the Identity Projection store (from P2) on hot path; falls back to live six-layer resolve only on miss. Lint blocks any non-resolver SDK from reading layer attributes directly (OC-4) |
| `@projexlight/sdk-data-rights` | SDK · NEW v3.1 | M · 4w | Privacy / Identity | DSAR/right-to-erasure workflow + **person_pool_residency** registry. Composes: subject request → identity verification → tenant approval (or auto-approve per policy) → mandatory grace period → execute (shred Person/persona/encounter key per request type) → certificate of completion |
| `@projexlight/sdk-geo` | SDK · NEW | L · 6w | Geo (Satyam) | Canonical `address_id` registry (Consolidation pattern); geocoding facade; bounding-box queries; provider abstraction (Mapbox · Google · OSM); PostGIS store |
| `@projexlight/sdk-device` | SDK · NEW | M · 4w | Mobile | Canonical `device_uuid` registry (Coexistence pattern with HDK); attestation; person↔device link; OS/app-version provenance |
| `@projexlight/sdk-feature-flags` | SDK · NEW | M · 3w | Platform | Per-tenant flag store; kill switches (especially per-agent); rollout cohorts; client-side evaluator |
| `native/hdk-idp` | HDK · NEW | M · 4w | Shoaib · Krunal | Native biometric + PIN; offline auth; integrates with sdk-identity for online sync |
| `native/hdk-permissions` | HDK · NEW | M · 4w | Mayur | Permission UI primitives; integrates with sdk-policy + sdk-rebac + sdk-consent |
| `native/hdk-diagnostic` | HDK · NEW | M · 3w | Kunal | Diagnostic telemetry stubs; integrates with sdk-diagnostic-telemetry (P7) |
| **`native/hdk-sync`** | HDK · NEW v3.1 | L · 5w | Mobile · TBD | The offline write queue + replay engine + per-event-type Conflict Resolution Model execution. CRDT · LWW · merge · event-sourcing · human-review per event type. **MUST land before hdk-camera/map (week 28)** |
| **Architecture §6A** Conflict Resolution Model | Doctrine · NEW | — | Mobile + Platform Architect | Published in Architecture; per-event-type policy in contracts; hdk-sync implements |
| `services/identity-projector` | Service · UPDATED | — | Identity | Already running from P2; consume P3 event types (persona/profile changes) to update projection |

---

## 4 · User stories

### As a **Platform Engineer**
- **US-PE-1**: I call `resolveIdentityContext(token)` and get a typed `IdentityContext` object with snapshot-stable identity data; my service never walks the six layers by hand.
- **US-PE-2**: I import sdk-persona to create a new persona — at no point do I touch sdk-identity directly (lint blocks it); I always use the resolver.
- **US-PE-3**: I declare an event type `clinical.note.edit.v1` in contracts and register its conflict policy as `crdt:rga-text`; hdk-sync resolves multi-device edits automatically.

### As a **ProjexCloud Operator**
- **US-OP-1**: A regulator asks "show me where person X's data is stored." I query `person_pool_residency` and get back the complete list of pools + data classes referencing them.
- **US-OP-2**: I trigger a DSAR for a person; the workflow executes in <30 days; certificate signed by Audit; reconciliation confirms no pool was missed.

### As a **Tenant Admin**
- **US-TA-1**: I configure my tenant's data-rights policy: erasure auto-approve for non-employee subjects; manager-approval-required for employee subjects.
- **US-TA-2**: I see DSAR requests in the Tenant Admin Portal with progress + SLA countdown.

### As a **Tenant Employee** (field worker using HDK app)
- **US-EU-1**: I capture data offline in the field; when my device reconnects, my edits sync with the server; conflicts with another field worker's edits are resolved per the event-type policy (CRDT merge for notes, LWW for timestamps, human-review queue for clinical corrections).
- **US-EU-2**: I switch between personas (Doctor at Hospital A → Patient at Hospital B); the resolver refreshes within 1s; my data view updates without re-login.

### As a **Data Subject** (a person whose data is in the system)
- **US-DS-1**: I submit a DSAR via my tenant's portal; within 30 days I receive a unified export of all my data across every app and tenant where I have a presence; my person key is shredded; certificate of destruction returned.

### As a **Mobile Engineer** (building a vertical's HDK app)
- **US-ME-1**: I add an offline-write feature to my app; I don't write any queue or replay code — I declare the event type's conflict policy in contracts, call hdk-sync's helper, and reconnection-time conflict resolution happens automatically.

---

## 5 · Functional requirements (per SDK / component)

### 5.1 · `@projexlight/sdk-profile`

**Purpose:** Profile bands re-homed to App Identity (per-app) while Secure Data stays on Master Person.

**Owns:**
- FR-PRF-1: Profile / Preference / Notification-routing band — per-app, lives on L2 App Identity
- FR-PRF-2: Secure Data band (DL · PAN · Aadhaar · SSN · Passport · PCI tokens) — stays on L1 Master Person with per-field envelope encryption (sdk-vault)
- FR-PRF-3: Per-band read/write via resolver (no direct identity reads)
- FR-PRF-4: Per-band consent check (sdk-consent) before any read
- FR-PRF-5: Per-band audit (sdk-audit) on every read or write
- FR-PRF-6: Field-level shred (e.g., shred PAN without shredding the rest of Secure Data band)

**Database / storage:** `profile` schema in Admin Pool (Secure Data + L2 bands); per-field envelope encryption via Vault.

**Events published:** `profile.band.updated.v1` · `profile.field.shredded.v1`

**Pool placement:** L2 bands on App Identity (Admin Pool); Secure Data on L1 Master Person (Admin Pool, person's home region pinned).

**SKUs:** `profile.read` · `profile.update` · `profile.field.shred` — `flat_per_call`.

### 5.2 · `@projexlight/sdk-persona`

**Purpose:** The L2/L3/L4 identity layer. Every domain SDK navigates through Persona.

**Owns:**
- FR-PSN-1: App Identity (L2) CRUD — one row per `(person_id × app_id)`
- FR-PSN-2: Tenant Membership (L3) CRUD — one row per `(app_identity_id × tenant_id)`
- FR-PSN-3: Persona (L4) CRUD — typed by kind (Patient · Doctor · Buyer · Donor · Investor · …)
- FR-PSN-4: Per-app role registry (role templates) consumed at persona creation
- FR-PSN-5: Multi-persona-per-membership support (e.g., doctor-who-is-also-patient)
- FR-PSN-6: Persona extension join to app pools (persona-extension data — donor history, patient chart root, investor stake — lives in app pool)
- FR-PSN-7: Persona shred independent of Person shred (a tenant can shred a persona without losing the person across other tenants)
- FR-PSN-8: Per-persona audit chain
- FR-PSN-9: Emits `identity.persona.created.v1` · `identity.persona.shred.v1` (consumed by Identity Projector for refresh)

**Database / storage:** `persona` schema (identity facet) in Admin Pool; persona-extension data in App Pool.

**Events published:** `identity.persona.created.v1` · `identity.persona.shred.v1` · `identity.membership.created.v1` · `identity.membership.suspended.v1` · `identity.membership.reactivated.v1` · `identity.role.assigned.v1` · `identity.role.revoked.v1`

**Pool placement:** Identity facet in Admin Pool; extension data in App Pool.

**SKUs:** `persona.create` · `persona.shred` · `persona.role.assign` · `persona.extension.read` · `persona.extension.write` — `flat_per_call` (extension R/W: `tiered_per_call` for high volume).

### 5.3 · `@projexlight/sdk-identity-resolver`

**Purpose:** The single canonical entry point for reading identity. Wraps the Identity Projection store.

**Owns:**
- FR-IDR-1: `resolveIdentityContext(token)` returns a frozen `IdentityContext` object
- FR-IDR-2: Hot path: read from Redis projection store (p99 ≤ 0.5ms warm)
- FR-IDR-3: Cold path: read from Postgres projection store (p99 ≤ 5ms)
- FR-IDR-4: Fallback: live six-layer resolve (only on cache+DB miss; emits an alert)
- FR-IDR-5: Snapshot stability — one IdentityContext per request lifetime; `projection_version` propagates
- FR-IDR-6: Debug API: explain attribute provenance ("why did this call see persona X?")
- FR-IDR-7: Memoization within request lifetime
- FR-IDR-8: Lint rule (OC-4) blocks any non-resolver SDK from reading layer attributes directly

**Public API surface (selected):**
```ts
export async function resolveIdentityContext(token: JWT): Promise<IdentityContext>;
export interface IdentityContext {
  person_id: string;
  app_id: string;
  tenant_id: string;
  bu_id?: string;
  bu_ancestors: string[];
  parent_tenant_id?: string;
  root_tenant_id: string;
  reseller_id?: string;
  geo_node_id?: string;
  primary_persona_id: string;
  all_persona_ids: string[];
  effective_role_closure: string[];
  abac_attributes: Record<string, unknown>;
  rebac_edges: Record<string, RebacEdge[]>;
  active_consents: Record<string, ConsentReceipt>;
  effective_scopes: string[];
  admin_pool_index: string;
  app_pool_index: string;
  projection_version: bigint;
  // ... see AIM §2B.1 for full schema
}
export function explain(ctx: IdentityContext, attribute: string): AttributeProvenance;
```

**Database / storage:** Reads from `projection` schema (Admin Pool, durable) and Redis hot store; no writes.

**Pool placement:** Stateless; per-request reads Admin Pool + one App Pool (sanctioned two-pool fetch).

**SKUs:** `resolver.resolve` — `flat_per_call` (very cheap; bundled in caller's SKU usually).

### 5.4 · `@projexlight/sdk-data-rights`

**Purpose:** End-to-end DSAR / right-to-erasure workflow with cross-pool fan-out.

**Owns:**
- FR-DR-1: `person_pool_residency` registry — schema in person's home Admin Pool; written on first-touch by every data-bearing SDK
- FR-DR-2: DSAR request types: Access (Art 15) · Erasure (Art 17) · Rectification (Art 16) · Restriction (Art 18) · Objection (Art 21) · Portability
- FR-DR-3: Workflow state machine: `submitted → identity-verified → approval-pending → grace-period → executing → certificate-issued → audited`
- FR-DR-4: Per-jurisdiction regulator-clock SLA enforcement (30d GDPR · 30d DPDP · 45d CCPA — configurable per jurisdiction)
- FR-DR-5: Erasure execution: shred Person Key OR scoped persona key OR encounter key per request type
- FR-DR-6: Unified data export (composes Profile + Persona + Engagement + … per pool) into one signed bundle for portability/access requests
- FR-DR-7: Certificate of completion signed by Audit + cryptographic proof of shred
- FR-DR-8: Weekly reconciliation job — `person_pool_residency` vs actual data presence; discrepancy halts further DSAR completion
- FR-DR-9: Tenant-configurable approval policy (auto-approve · manager-approval · cross-tenant-approval)

**Database / storage:** `data_rights` schema in Admin Pool (workflow state) + `person_pool_residency` table in person's home Admin Pool.

**Events published:** `data-rights.request.submitted.v1` · `data-rights.executed.v1` · `data-rights.certificate.issued.v1` · `pool-residency.touched.v1`

**Pool placement:** Workflow in Admin Pool; fan-out to every pool listed in residency registry.

**SKUs:** `data-rights.request.submit` · `data-rights.execute` · `data-rights.export` — `per_unit` (per-MB for exports; flat for requests).

### 5.5 · `@projexlight/sdk-geo`

**Purpose:** Canonical `address_id` registry + geocoding facade.

**Owns:**
- FR-GEO-1: Canonical `address_id` (Consolidation pattern — duplicates resolved to one canonical row)
- FR-GEO-2: Geocoding facade with provider abstraction (Mapbox · Google · OSM)
- FR-GEO-3: Bounding-box queries (PostGIS-backed)
- FR-GEO-4: Reverse-geocoding (lat/lng → canonical address)
- FR-GEO-5: GeographicNode tree integration — every address tagged with its `geo_node_id`

**Database / storage:** `geo` schema in Admin Pool (with PostGIS) + Global Catalog (GeographicNode tree).

**Events published:** `geo.address.canonicalized.v1` · `geo.address.merged.v1`

**Pool placement:** Admin Pool + Global Catalog.

**SKUs:** `geo.geocode` · `geo.reverse-geocode` · `geo.bbox-query` — `passthrough_plus_margin` (provider cost + 15%).

### 5.6 · `@projexlight/sdk-device`

**Purpose:** Canonical `device_uuid` registry with attestation.

**Owns:**
- FR-DEV-1: `device_uuid` per physical device (Coexistence pattern with HDK)
- FR-DEV-2: Device attestation (signed device claim from HDK-idp)
- FR-DEV-3: Person ↔ device link (which persons have used which devices)
- FR-DEV-4: OS / app-version provenance (which OS, which app build last seen)
- FR-DEV-5: Device kill switch (revoke a stolen device)

**Database / storage:** `device` schema in Admin Pool.

**Events published:** `device.registered.v1` · `device.attested.v1` · `device.revoked.v1`

**Pool placement:** Admin Pool.

**SKUs:** `device.register` · `device.attest` · `device.revoke` — `flat_per_call`.

### 5.7 · `@projexlight/sdk-feature-flags`

**Purpose:** Per-tenant flag store with kill switches.

**Owns:**
- FR-FF-1: Per-tenant flag store (key/value with typed schema)
- FR-FF-2: Kill switches (especially per-agent — critical for P6A safety)
- FR-FF-3: Rollout cohorts (% rollout · canary tenants · A/B variants)
- FR-FF-4: Client-side evaluator (cached locally; refreshes from server periodically)
- FR-FF-5: Audit of every flag change

**Database / storage:** `feature_flags` schema in Admin Pool + Redis evaluator cache.

**Events published:** `feature-flag.updated.v1` (operational retention)

**Pool placement:** Admin Pool.

**SKUs:** `feature-flag.evaluate` (high volume; bundled) · `feature-flag.update` — `flat_per_call`.

### 5.8 · `native/hdk-sync` — the critical new module

**Purpose:** Owns the offline write queue + replay engine + per-event-type Conflict Resolution Model execution.

**Owns:**
- FR-HS-1: On-device offline write queue (durable storage; survives app restart)
- FR-HS-2: Replay engine on reconnect (idempotent, replay-safe)
- FR-HS-3: Per-event-type conflict-resolution policy execution (declared in contracts)
- FR-HS-4: Five strategies:
  - **CRDT** (G-counter, PN-counter, LWW-set, OR-set, RGA-text) for collaborative data
  - **LWW** for ephemeral state (telemetry, sensor readings)
  - **Merge Policy** (per-field rules: additive, max, last-write, veto) for structured docs
  - **Event Sourcing** for audit/ledger-style data
  - **Human Reconciliation** for sensitive data (queue + sdk-approval delegation)
- FR-HS-5: Audit emit for every conflict (both inputs + resolved output)
- FR-HS-6: TS facade + iOS native (Swift) + Android native (Kotlin); parity verified by CI
- FR-HS-7: Bounded queue size with overflow policy (oldest-non-critical drops; critical events block)

**Public API surface (selected):**
```ts
// TS facade for app code
import { syncQueue } from '@projexlight/hdk-sync';

syncQueue.enqueue({
  event_type: 'clinical.note.edit.v1',
  payload: { ... },
  tenant_id, persona_id, ...
});

// On reconnect, the native side replays + resolves per the event type's ConflictPolicy
// Conflict resolution decisions emit to sdk-audit; human-review queue items appear in Tenant Workspace
```

**Database / storage:** On-device SQLite for queue; server-side reconciler service writes to App Pool.

**Events published:** `hdk-sync.queue.replayed.v1` · `hdk-sync.conflict.resolved.v1` · `hdk-sync.conflict.escalated-to-human.v1`

**Pool placement:** Per-device local; server-side reconciliation in App Pool (per-tenant).

**SKUs:** `hdk-sync.event.enqueue` · `hdk-sync.event.reconcile` · `hdk-sync.conflict.human-review` — `flat_per_call` (with human-review at higher rate).

### 5.9 · `hdk-idp`, `hdk-permissions`, `hdk-diagnostic`

(Standard HDK foundation modules — each follows the HDK template with TS facade + iOS + Android natives; parity-gated.)

---

## 6 · Non-functional requirements

| Dimension | Target |
|---|---|
| Resolver hot-path latency (p99) | ≤ 0.5ms warm Redis · ≤ 5ms cold Postgres |
| Profile read (with consent + ABAC check) latency | ≤ 10ms p99 |
| DSAR end-to-end (request → certificate) | ≤ 30 days per GDPR; per-jurisdiction configurable |
| hdk-sync replay throughput | 1000 events/sec per device |
| hdk-sync conflict resolution latency | ≤ 100ms p99 for CRDT/LWW/merge; human-review SLA per tenant |
| Person-pool-residency reconciliation drift | ≤ 0.01% (weekly job) |
| HDK parity (iOS vs Android feature drift) | 0 — CI blocks |
| Geo provider failover | ≤ 5s on provider error |

---

## 7 · Acceptance criteria (the phase exit gate)

| # | Criterion | Owner | Test plan |
|---|---|---|---|
| **AC-1** | One person → 5+ App Identities → 10+ Memberships → 12+ Personas with independent persona shred | Identity | Synthetic-scale integration test |
| **AC-2** | Persona shred independent of person shred | Identity | Chaos drill |
| **AC-3** | Notification reads only App Identity routing band (lint blocks Master Person reads) | Identity | CI rule test |
| **AC-4** | Geo resolves duplicate addresses to one `address_id` | Geo | Synthetic dedup test |
| **AC-5** | Device row joins on biometric (HDK device claim verifies against sdk-device) | Mobile | Integration test |
| **AC-6** | `resolveIdentityContext()` is the only path to layer attributes (lint forbids direct sdk-identity/sdk-persona imports in non-resolver SDKs) | Identity | CI rule test |
| **AC-7** | Resolver p99 ≤ 1ms warm (Redis projection hit) | Identity | Load test |
| **AC-8** | Identity projection refreshed within 1s of relationship change (already verified in P2 but re-validated as P3 SDKs subscribe) | Identity | Integration test |
| **AC-9** | **DSAR test:** synthetic person across 3 apps + 5 personas + 12 encounters → unified export within 30d; erasure shreds Person Key → 12 encounters undecryptable; certificate signed by Audit | Privacy | End-to-end scenario test |
| **AC-10** | `person_pool_residency` reconciliation green: registry matches actual data presence across all pools | Privacy | Weekly reconciliation job |
| **AC-11** | **hdk-sync 5-device offline-edit collision test:** resolves per Conflict Resolution Model (CRDT for notes, LWW for telemetry, human-review queue for sensitive); zero silent data loss; resolution decisions audited per conflict | Mobile | Multi-device chaos drill |
| **AC-12** | hdk-idp, hdk-permissions, hdk-diagnostic, hdk-sync ship with iOS + Android parity verified by CI matrix | Mobile | Cross-platform CI |
| **AC-13** | Conflict Resolution Model published as Architecture §6A; per-event-type policy in contracts; every event registered in EventTypeRegistry has a declared `conflict_policy` | Mobile + Platform Architect | Doc + registry inspection |
| **AC-14** | All P3 SDKs published as v1.0.0 to private registry | Platform | `npm view` checks |

---

## 8 · Test plan (per acceptance criterion)

### AC-9 · DSAR end-to-end

**Scenario:**
1. Synthetic person `pers_test_dsar` provisioned across 3 apps (healthcare, realty, ecommerce) with 5 personas + 12 encounters
2. `person_pool_residency` correctly populated (5 pool entries × multiple data classes)
3. DSAR Erasure request submitted → identity verified → tenant auto-approves → 7-day grace period (compressed to 7s in test) → execute
4. Execute: shred Person Key
5. Verify: every read across all 5 pools returns Undecryptable; cert of completion contains shred timestamp + chain link

**Pass condition:** All steps complete within test time budget; no pool missed; reconciliation job confirms zero residual data.

### AC-11 · hdk-sync 5-device offline conflict

**Scenario:**
- 5 simulated devices, all offline
- Each writes 100 events to the same encounter over 30s: mix of `clinical.note.edit.v1` (CRDT), `device.location.update.v1` (LWW), `payment.refund.v1` (human-review)
- Devices reconnect in random order
- hdk-sync replays + resolves per policy

**Pass condition:**
- CRDT notes: all 500 edits merged; final text is deterministic (independent of replay order)
- LWW locations: highest timestamp wins per device-time combo; losers in audit
- Human-review refunds: 5 items in the review queue with diffs visible
- Audit chain unbroken; 0 silent losses

### AC-7 · Resolver hot path

**Scenario:** Load test 10k req/s of `resolveIdentityContext(token)` against pre-warmed projection.

**Pass condition:** p99 ≤ 1ms warm; cache hit rate > 99%; cold fallback emits alert but does not error.

### AC-13 · Conflict Resolution Model doctrine

**Scenario:** Audit every event type registered in `EventTypeRegistry`; verify each has a `conflict_policy` field set.

**Pass condition:** 100% coverage; CI rule blocks any new event type registration without a `conflict_policy`.

---

## 9 · Dependencies

- ✅ P2 exit gate green
- ✅ Identity Projector worker running and populating `subject_view` from P2 events
- ✅ Vault + Audit + Pool Router + Meter from P1 stable
- ✅ At least one app pool per vertical in dev region
- ✅ Mobile dev infrastructure (iOS provisioning + Android signing) ready for HDK builds

---

## 10 · Out of scope (deferred to later phases)

- ❌ Operational SDKs (Media, Notification, Payment, Workflow, Search) — P4
- ❌ Billing + invoicing — P4
- ❌ Webhooks, Approval, Tenant Lifecycle — P4
- ❌ Connectors framework + connector-slack — P4
- ❌ Engagement (Encounter, Relationship CRUD) — P5
- ❌ hdk-camera, hdk-map (depend on hdk-sync from this phase) — P4
- ❌ Cross-pool lineage projection — P6B

---

## 11 · Risks

| # | Risk | Severity | Likelihood | Mitigation |
|---|---|---|---|---|
| R-1 | Lint rule OC-4 (resolver-only) breaks existing P1/P2 sample apps | M | M | Sample apps refactored before merging the lint rule; week 16 dependency audit |
| R-2 | DSAR fan-out misses a pool because residency registry is incomplete | H | M | Weekly reconciliation job; DSAR completion blocked if reconciliation is red |
| R-3 | hdk-sync introduces a regression in HDK-idp's offline auth | M | L | hdk-sync depends on hdk-idp's contract; integration tests cover both |
| R-4 | Persona-extension joins to app pool latency exceeds 5ms | M | M | Pre-join in projection; cache aggressively; app-pool reads short-circuited via resolver |
| R-5 | Per-jurisdiction DSAR SLA mismatches (some require <30d) | M | L | Per-jurisdiction configuration; default 30d but tenants can tighten |
| R-6 | hdk-sync replay-order issue: late-arriving CRDT edit changes already-finalized state | M | M | CRDT design guarantees order-independence; chaos test verifies |
| R-7 | iOS/Android parity drift for hdk-sync (e.g., SQLite WAL behavior differs) | M | M | Shared test fixtures; per-platform reconciliation tests in CI matrix |

---

## 12 · Rollout plan

1. **Week 15–16**: sdk-profile + sdk-persona first (depends on resolver projection from P2)
2. **Week 15–17**: sdk-identity-resolver (consumes projection; lint rule activated week 17)
3. **Week 16–19**: sdk-data-rights + person_pool_residency registry; first synthetic DSAR test week 18
4. **Week 15–20**: sdk-geo (long pole at 6w; Geo team owns) — provider abstraction layer first, then PostGIS
5. **Week 16–19**: sdk-device + sdk-feature-flags (parallel)
6. **Week 17–21**: HDK foundation track — idp · permissions · diagnostic
7. **Week 18–22**: hdk-sync (5w; critical path for P4 HDK camera/map)
8. **Week 21**: Multi-device hdk-sync chaos drill in staging
9. **Week 22**: Phase exit-gate review

---

## 13 · Open questions / decisions needed

- [ ] Q-1: DSAR auto-approve default — tenant configurable; system default = manager-approval-required
- [ ] Q-2: hdk-sync local-queue size limit per device — 100MB default; overflow policy?
- [ ] Q-3: Geo provider order of preference per region (Google Maps unavailable in China → OSM fallback)
- [ ] Q-4: Should hdk-sync support "client-driven conflict policy override" or stay strictly contracts-driven? — recommend strictly contracts-driven (no client-side override) for auditability
- [ ] Q-5: Persona-extension app-pool placement — already P3-defined; confirm with vertical teams during week 16 design review

---

## 14 · Sign-off

| Role | Name | Date | Status |
|---|---|---|---|
| Phase DRI | Identity WG + Mobile Lead | | |
| Platform Architect | Tanveer | | |
| Privacy / Compliance | TBD | | |
| Identity Working Group | | | |
| Mobile Lead | Kunal | | |
