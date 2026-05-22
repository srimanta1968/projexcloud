# PRD · P7 — Field + Evidence + Hyperscale

| Field | Value |
|---|---|
| **Phase** | P7 |
| **Window** | Weeks 44–50 (~6 weeks) |
| **Maps to wave(s)** | W7 + final HDK modules |
| **Gates closed** | G10 (pool federation runtime) · G11 (Iceberg lakehouse full federation) |
| **Status** | DRAFT |
| **Owner (DRI)** | FieldOps WG + Platform Architect |
| **Companion docs** | `../docs/v3.1/Architecture-v3.1.html` §10 (encryption) · §22A (deployment variants) · `../docs/v3.1/SDK-Build-Plan-v3.1.html` §W7 |

---

## 1 · TL;DR

P7 ships the **field-grade SDKs** (Storm · Dispatch · Assignment · Lead Scoring · Evidence · Diagnostic Telemetry) that power FieldOps, OneEstate Sentinel, Realty visits, and Healthcare imaging. **Evidence** + chain-of-custody depend on Vault + Audit + Geo + Media + Device + Engagement — building earlier means evidence is mutable, which defeats its legal purpose. P7 also closes the **hyperscale gates**: full pool federation runtime (real one, not just hooks) handling the 1000+ pool world (G10) and the full Iceberg lakehouse read federation (G11). Meter switches from soft caps to **hard caps (DENY)** — pay-as-you-use is fully enforced.

---

## 2 · Why this phase now

By P7, all upstream pieces are stable: Vault (P1) · Audit (P1) · Geo (P3) · Media (P4) · Device (P3) · Engagement (P5) · Agent Runtime (P6A) · Lineage (P6B). The field-grade SDKs become thin facades over these. Evidence specifically MUST be the last domain SDK to ship — its chain-of-custody story depends on every encryption tier, audit chain, and lineage edge already being in place. Building Evidence earlier means evidence is mutable; defeating its legal purpose.

Pool federation runtime lands here because it's only needed once pool count exceeds 200 (genuinely hyperscale). Until then, the hooks shipped in P1 suffice. Iceberg lakehouse full federation upgrades the partial layer from P6B. Hard caps activate here because we've now had ~30 weeks of meter data to calibrate the catalog against real load.

---

## 3 · What ships in this phase

| Component | Type | Effort | Owner | Notes |
|---|---|---|---|---|
| `@projexlight/sdk-storm` | SDK · NEW | M · 3w | FieldOps | Storm overlays (pre/post); intensity grids; ingested from weather APIs to internal store |
| `@projexlight/sdk-dispatch` | SDK · MODIFIED | M · 4w | FieldOps | Unified queue (engagement-aware); live WS updates; route optimization |
| `@projexlight/sdk-assignment` | SDK · NEW | M · 3w | FieldOps | Auto-assign by radius/skill/availability; territory rules |
| `@projexlight/sdk-lead-scoring` | SDK · NEW | M · 4w | Prashant | Proximity · expertise · intent · storm-impact scoring; next-best-action |
| `@projexlight/sdk-evidence` | SDK · MODIFIED v3 | L · 5w | FieldOps | Provenance-stamped captures (GPS · IMU · device · consent_ref); raw + edited retention; chain-of-custody hash; legal-export API; stamps `encounter_id` on every capture; sealing encounter prevents new evidence; per-encounter retention shreds the right blobs |
| `@projexlight/sdk-diagnostic-telemetry` | SDK · NEW | M · 3w | Kunal | Crash snapshots tied to `device_uuid`; permissions/Wi-Fi/battery/sensor health; session replay events |
| **Pool Federation Runtime** | Service · NEW v3.1 | L · 5w | Platform | The real runtime (not just hooks from P1) — regional-federation router selects routes across federations when pool count > 200; per-region capacity; auto-failover for Tier-G (G10) |
| **Iceberg Full Lakehouse Federation** | Infra + SDK extension v3.1 | M · 4w | Data Platform | Upgrades partial layer from P6B — cross-pool reports route through here, not warehouse ClickHouse alone (G11) |
| `native/hdk-measure` | HDK · NEW | L · 5w | TBD | AR-based measurement (ARCore/ARKit); depends on hdk-camera |
| `native/hdk-watermark` | HDK · NEW | M · 3w | TBD | Image/video watermarking for evidence; depends on hdk-image-editor |
| **Meter mode switch** | Config change | — | Platform | Soft caps → **hard caps (DENY)**; tenants past hard cap denied with quota-exceeded error |

---

## 4 · User stories

### As a **Field Contractor** (FieldOps app user)
- **US-FC-1**: I capture damage assessment in the field with HDK camera; every photo is GPS-stamped, device-attested, encounter-tagged; chain-of-custody hash linked into Audit; signed for legal export.
- **US-FC-2**: I use HDK measure (AR) to estimate roof area without a tape measure; measurement saved with photo evidence.
- **US-FC-3**: My dispatcher assigns me a job; I see route optimization based on storm overlay + my territory + my available time slots.

### As an **Insurance Adjuster**
- **US-IA-1**: A storm hit a region last week; sdk-storm has overlay; affected properties auto-prioritized in lead scoring.
- **US-IA-2**: I export evidence chain-of-custody for a disputed claim; signed PDF with all metadata + cryptographic proof of non-tampering.

### As a **ProjexCloud Operator**
- **US-OP-1**: Pool count crossed 220 in EU region; federation runtime auto-routes; latency stays within SLO.
- **US-OP-2**: I trigger a cross-pool query for compliance reporting across 50 pools; Iceberg lakehouse returns results in <30s.
- **US-OP-3**: A tenant exceeds hard cap; meter denies further requests; tenant gets warning + escalation; operations triage.

### As a **Tenant Admin**
- **US-TA-1**: I see hard-cap warnings 24h before the wall; can request upgrade or accept rate limit.
- **US-TA-2**: I export evidence collection for litigation; one click → signed legal-export bundle.

### As a **Vertical Engineer** (Healthcare imaging)
- **US-VE-1**: Imaging captured via HDK camera + hdk-watermark; chain-of-custody linked to encounter; HIPAA-grade evidence.

---

## 5 · Functional requirements (per SDK / component)

### 5.1 · `@projexlight/sdk-storm`

**Owns:**
- FR-STM-1: Storm overlays (pre-event + post-event) — ingested from weather APIs
- FR-STM-2: Intensity grids (wind, hail size, rainfall) per geo bounding box
- FR-STM-3: Historical storm archive
- FR-STM-4: Per-region storm event registry

**SKUs:** `storm.overlay.query` (per-bbox query) — `flat_per_call`.

### 5.2 · `@projexlight/sdk-dispatch`

**Owns:**
- FR-DSP-1: Unified queue (engagement-aware — work units are encounters)
- FR-DSP-2: Live WebSocket updates to dispatched personas
- FR-DSP-3: Route optimization (consumes sdk-geo)
- FR-DSP-4: Per-tenant dispatch policies

**SKUs:** `dispatch.queue.enqueue` · `dispatch.route.optimize` — `tiered_per_call`.

### 5.3 · `@projexlight/sdk-assignment`

**Owns:**
- FR-ASN-1: Auto-assign by radius / skill / availability
- FR-ASN-2: Territory rules
- FR-ASN-3: Workload balancing across personas

**SKUs:** `assignment.assign` — `flat_per_call`.

### 5.4 · `@projexlight/sdk-lead-scoring`

**Owns:**
- FR-LSC-1: Proximity · expertise · intent · storm-impact scoring
- FR-LSC-2: Next-best-action recommender (composes with sdk-recommendation)
- FR-LSC-3: Per-tenant model (similar to sdk-recommendation; vertical-specific tuning)

**SKUs:** `lead-scoring.score` · `lead-scoring.next-action` — `tiered_per_call`.

### 5.5 · `@projexlight/sdk-evidence` — the chain-of-custody linchpin

**Owns:**
- FR-EVD-1: Provenance-stamped captures (GPS · IMU · device_uuid · timestamp · consent_ref)
- FR-EVD-2: Raw + edited retention (both kept; edits never overwrite raw)
- FR-EVD-3: Chain-of-custody hash linked to Audit chain
- FR-EVD-4: Legal-export API (signed PDF + JSONL + media files in a packaged bundle)
- FR-EVD-5: Every capture stamped with `encounter_id` (sealing encounter prevents new captures referencing it)
- FR-EVD-6: Per-encounter retention shreds the right blobs at retention expiry
- FR-EVD-7: Tamper-evident watermarking via hdk-watermark
- FR-EVD-8: Multi-jurisdiction legal-export formats (US courts · EU GDPR · India per IT Act)

**Database / storage:** `evidence` schema in Evidence Pool (metadata) + S3 (raw + edited blobs, per-tenant prefix).

**Events published:** `evidence.captured.v1` · `evidence.legal-export.generated.v1` · `evidence.shredded.v1` (retention or DSAR)

**Pool placement:** Evidence Pool (metadata) + S3 (blobs).

**SKUs:** `evidence.capture` (per-GB) · `evidence.legal-export.generate` (per-export) · `evidence.shred` (per-blob) — `per_unit`.

### 5.6 · `@projexlight/sdk-diagnostic-telemetry`

**Owns:**
- FR-DIA-1: Crash snapshots tied to `device_uuid`
- FR-DIA-2: Permissions / Wi-Fi / battery / sensor health reports
- FR-DIA-3: Session replay events (privacy-sanitized; no PII)
- FR-DIA-4: Per-tenant rollups in ClickHouse for ops dashboards

**SKUs:** `diagnostic.crash.report` · `diagnostic.session-replay.event` — `flat_per_call`.

### 5.7 · Pool Federation Runtime

**Owns:**
- FR-FED-1: Regional federation router (selects routes across federations when pool count > 200)
- FR-FED-2: Per-region capacity management
- FR-FED-3: Auto-failover for Tier-G to paired region
- FR-FED-4: Chaos-tested against simulated 3-region federations
- FR-FED-5: Manages `PoolFederationManifest` (already in contracts from P1)

**Pool placement:** Federation Registry in each region's Admin Pool; routing decisions stateless.

### 5.8 · Iceberg Full Lakehouse Federation

**Owns:**
- FR-LH-1: Upgrades partial layer from P6B
- FR-LH-2: All cross-pool reports route through Iceberg, not Warehouse ClickHouse alone
- FR-LH-3: Per-region Iceberg catalog (Glue · Nessie)
- FR-LH-4: Partition strategy: `(region · tenant · time)` with Z-order on common predicates
- FR-LH-5: Cross-pool lineage projection (G8) writes here
- FR-LH-6: Snowflake bridge (P6B) reads/writes here

### 5.9 · HDK measure + watermark

Standard HDK templates; AR (ARCore/ARKit) for measure; image/video watermarking for evidence integrity.

---

## 6 · Non-functional requirements

| Dimension | Target |
|---|---|
| Evidence capture → vault encryption | ≤ 500ms |
| Evidence legal-export bundle generation | ≤ 60s for 1GB |
| Chain-of-custody hash verification | ≤ 5s per export |
| Dispatch route optimization | ≤ 1s for 50-stop route |
| Pool federation routing decision | ≤ 5ms p99 (matches sdk-pool-router SLA) |
| Iceberg lakehouse query (PB-scale) | ≤ 30s p99 |
| Hard cap denial latency | ≤ 2ms (existing meter budget) |
| HDK measure accuracy (AR) | ±5% for areas ≤ 100m² |

---

## 7 · Acceptance criteria (the phase exit gate · matches §0A.4 P7)

| # | Criterion | Owner | Test plan |
|---|---|---|---|
| **AC-1** | Field capture from HDK → Evidence → Vault → Audit chain-of-custody (with `encounter_id`) verified | FieldOps | End-to-end capture test |
| **AC-2** | Dispatch + Assignment route end-to-end (queue → assign → dispatch → completion) | FieldOps | Integration test |
| **AC-3** | Lead Scoring scores a CRM lead with proximity + expertise + intent factors | Prashant | Scoring test |
| **AC-4** | Storm overlay ingested from weather API; per-bbox query returns correct intensity grid | FieldOps | API integration test |
| **AC-5** | Diagnostic telemetry: crash snapshot tied to `device_uuid` queryable in ops dashboard | Kunal | Integration test |
| **AC-6** | **Pool federation runtime routes a query across 3 simulated regional federations** (G10) | Platform | Chaos drill |
| **AC-7** | **Iceberg lakehouse extracts queryable by analytics tools** (Trino, Athena) at PB scale (G11) | Data Platform | Load test |
| **AC-8** | **Meter hard caps DENY** a synthetic over-quota tenant | Platform | Quota test |
| **AC-9** | Evidence legal-export: signed PDF + JSONL bundle for a multi-capture scenario; chain-of-custody verifies; tamper-injection caught | FieldOps + Legal | Manual review by legal counsel |
| **AC-10** | HDK measure + watermark ship with iOS + Android parity | Mobile | CI matrix |
| **AC-11** | Sealing an encounter prevents new evidence captures referencing it | FieldOps | Integration test |
| **AC-12** | Per-encounter retention shreds the right blobs at retention expiry | FieldOps | Chaos drill |
| **AC-13** | All P7 SDKs published as v1.0.0 | Platform | `npm view` |

---

## 8 · Test plan (selected)

### AC-6 · Pool federation 3-region routing

**Scenario:**
- Set up 3 simulated regional federations (us-east · eu-west · ap-south), each with 5 pools
- Tenants exist in each region
- Run a cross-region query (warehouse-routed, not transactional)
- Verify federation router selects correct routes per region; results merge in warehouse

**Pass condition:** Query completes; no cross-region transactional join attempted; per-region latency within budget; routing audited.

### AC-9 · Evidence legal-export with tamper detection

**Scenario:**
- Field contractor captures 10 photos of storm damage at a property over 30min
- Each photo stamped with GPS + device_uuid + encounter_id + consent_ref
- Generate legal-export bundle (signed PDF + JSONL + photos)
- Tamper-injection: modify one byte of one photo in the bundle
- Re-verify chain-of-custody

**Pass condition:** Tamper-injection caught; verification reports the specific failed hash; original bundle valid before injection.

### AC-8 · Hard cap DENY

**Scenario:**
- Test tenant with monthly quota of 10k API calls
- Run 10k legitimate calls — all succeed
- 10,001st call → meter gate returns DENY
- Tenant Admin sees quota exceeded warning; option to request increase

**Pass condition:** Denial latency ≤ 2ms; clear error message returned to client; alerts fire; per-tenant usage dashboard shows current state.

---

## 9 · Dependencies

- ✅ P6B exit gate green (lineage projection + Iceberg partial in P6B; upgraded in P7)
- ✅ Vault + Audit + Geo + Media + Device + Engagement stable
- ✅ Iceberg infrastructure expanded for PB scale
- ✅ Weather API contract (NOAA · DTN · Weather Underground for storm data)
- ✅ Legal review of evidence-export format per jurisdiction

---

## 10 · Out of scope (deferred to P8 / backlog)

- ❌ Deployment variants (BYOK · sovereign · on-prem · active-active) — P8 (parallel)
- ❌ Industry-specific connectors (Epic · Cerner · MLS · Bloomberg) — vertical-driven, in vertical repos
- ❌ Heavy enterprise connectors (SAP · NetSuite · Workday) — backlog

---

## 11 · Risks

| # | Risk | Severity | Likelihood | Mitigation |
|---|---|---|---|---|
| R-1 | Hard caps DENY legitimate traffic when catalog isn't fully calibrated | H | M | 30 weeks of soft-cap data available before turning on DENY; per-tenant exception process; gradual rollout (canary tenants first) |
| R-2 | Evidence legal-export format rejected by a court | H | L | Legal counsel review of bundle format per jurisdiction before P7; per-jurisdiction templates |
| R-3 | Pool federation runtime introduces latency on routing not visible in tests | M | M | Federation tested against 3-region chaos pod; canary rollout to one region first |
| R-4 | Iceberg lakehouse query costs unbounded | M | M | Per-tenant query budgets; per-query cost estimation before execution |
| R-5 | HDK measure (AR) accuracy varies by device | M | H | Accuracy specs published per device class; tenant warned when accuracy not guaranteed |
| R-6 | Watermarking degrades photo evidence quality (forensic objection) | M | L | Optional watermarking; cryptographic hash maintained on raw |
| R-7 | Storm overlay weather-API outage at peak demand (post-storm) | H | L | Multi-provider fallback (NOAA + DTN + Weather Underground); cached overlays |

---

## 12 · Rollout plan

1. **Week 44–46**: sdk-storm + sdk-dispatch + sdk-assignment in parallel
2. **Week 44–48**: sdk-lead-scoring (4w) + sdk-evidence (5w; long pole)
3. **Week 44–47**: sdk-diagnostic-telemetry
4. **Week 44–48**: Pool federation runtime (5w; canary in one region first)
5. **Week 44–47**: Iceberg full lakehouse federation
6. **Week 46–48**: HDK measure + watermark
7. **Week 48**: Meter hard caps activated in dev region; canary tenants in production week 49
8. **Week 49**: Evidence legal-export legal review
9. **Week 50**: Phase exit-gate review; full v3.1 estate at v1.0

---

## 13 · Open questions / decisions needed

- [ ] Q-1: Pool federation activation threshold — auto-activate at 200 pools per region or manual operator decision?
- [ ] Q-2: Iceberg cost-allocation model — per-query bytes-scanned billed to tenant or absorbed?
- [ ] Q-3: Hard cap default action — DENY hard or DEGRADE (reduced-quality response)? Per-SKU configurable
- [ ] Q-4: HDK measure accuracy guarantee — publish per-device or one-size SLA?
- [ ] Q-5: Evidence retention default — 7y (matches HIPAA + most insurance)? Per-jurisdiction override

---

## 14 · Sign-off

| Role | Name | Date | Status |
|---|---|---|---|
| Phase DRI | FieldOps WG + Platform Architect | | |
| Platform Architect | Tanveer | | |
| Mobile Lead | Kunal | | |
| Data Platform Lead | | | |
| Legal Counsel (evidence export) | | | |
