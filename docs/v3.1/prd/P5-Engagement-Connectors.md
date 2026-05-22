# PRD · P5 — Engagement (Domain Layer) + Enterprise Connectors

| Field | Value |
|---|---|
| **Phase** | P5 |
| **Window** | Weeks 29–35 (~6 weeks) |
| **Maps to wave(s)** | W5 + HDK editors |
| **Gates closed** | — |
| **Status** | DRAFT |
| **Owner (DRI)** | Engagement WG lead + Integrations Lead |
| **Companion docs** | `../docs/v3.1/Architecture-v3.1.html` §13 · §15 (worked scenarios) · `../docs/v3.1/AgenticIntegration-v3.1.html` §6 |

---

## 1 · TL;DR

P5 ships the **domain layer** verticals build on top of: Encounter + Relationship lifecycles (the L5/L6 of identity), plus thin engagement SDKs (CRM · Content · Service Request · Event · Campaign · Social) that all reference `encounter_id` rather than reinventing visit/order/session primitives. P5 also ships the **enterprise connectors roster** — Salesforce, M365, GWorkspace, Jira, Linear, Zendesk, HubSpot, Zoom — so customers' existing tools plug into ProjexCloud immediately. HDK editors (scanner · image · video) round out field workflows.

---

## 2 · Why this phase now

With Persona (P3), Operational core + connectors framework (P4), and ReBAC (P2) in place, engagement SDKs become thin facades over the existing primitives. In v3.1, CRM/SR/Event reference `encounter_id` for their work units — building these before sdk-engagement means inventing redundant visit/order/session primitives that have to be unwound later. The connector roster lands here because the first vertical (likely Healthcare or Realty in P5) needs to import customer's existing Salesforce contacts, sync to Slack on key events, schedule via M365/GWorkspace calendars.

---

## 3 · What ships in this phase

| Component | Type | Effort | Owner | Notes |
|---|---|---|---|---|
| `@projexlight/sdk-engagement` | SDK · NEW v3 | L · 6w | Engagement WG | Encounter (L5) CRUD (open · in-progress · closed · sealed); Encounter participants (persona refs); per-encounter Vault key open/close; Relationship (L6) CRUD + lifecycle; Encounter Grants (time/scope-bounded tokens); Encounter→extension hooks |
| `@projexlight/sdk-crm` | SDK · MODIFIED v3 | L · 5w | Mayur | Contacts/Leads keyed by Persona; deal cycle = Engagement; CRM activities are sub-units of Engagement; per-vertical custom_fields JSONB |
| `@projexlight/sdk-content` | SDK · NEW | M · 3w | Platform | Generic typed-content with tenant-defined taxonomies; publishing workflow; signed playback hooks (media + content) |
| `@projexlight/sdk-service-request` | SDK · MODIFIED | M · 3w | Platform | Tickets as engagement-of-kind 'support'; routing rules; SLA timers; escalation workflows (sdk-workflow + sdk-approval) |
| `@projexlight/sdk-event` | SDK · MODIFIED | M · 3w | Platform | Event sessions as engagement-of-kind 'session'; ticketing; QR check-in; venue (`address_id`); capacity rules |
| `@projexlight/sdk-campaign` | SDK · NEW | M · 4w | Platform | Segment DSL over event stream; drip journeys; A/B variants |
| `@projexlight/sdk-social` | SDK · NEW | M · 3w | Platform | Pluggable channel connectors (composes with sdk-connectors); DM / comment ingestion; `social.lead.captured` events feeding CRM |
| `@projexlight/connector-salesforce` | Connector · NEW v3.1 | L · 5w | Integrations | Bidirectional sync of Accounts, Contacts, Leads, Opportunities → sdk-crm; SOQL query for agents; Bulk API; webhook + polling |
| `@projexlight/connector-microsoft365` | Connector · NEW v3.1 | L · 6w | Integrations | Graph API: SharePoint files · Outlook (mail + calendar) · Teams chat + meetings · OneDrive |
| `@projexlight/connector-gworkspace` | Connector · NEW v3.1 | L · 5w | Integrations | Drive · Gmail · Meet · Calendar · Docs/Sheets/Slides |
| `@projexlight/connector-jira` | Connector · NEW v3.1 | M · 3w | Integrations | Issues · sprints · boards; webhook ingestion; sdk-service-request bidirectional sync |
| `@projexlight/connector-linear` | Connector · NEW v3.1 | M · 2w | Integrations | Issues · projects; GraphQL API; webhook ingestion |
| `@projexlight/connector-zendesk` | Connector · NEW v3.1 | M · 3w | Integrations | Tickets bidirectional with sdk-service-request; macros, automations |
| `@projexlight/connector-hubspot` | Connector · NEW v3.1 | M · 4w | Integrations | For customers staying on HubSpot CRM but wanting ProjexCloud orchestration |
| `@projexlight/connector-zoom` | Connector · NEW v3.1 | S · 2w | Integrations | Meeting create · recording fetch · webhook ingestion |
| `native/hdk-scanner` | HDK · NEW | M · 3w | TBD | Barcode + QR + document scanning; depends on hdk-camera |
| `native/hdk-image-editor` | HDK · NEW | L · 5w | Shoheb | Crop, rotate, annotate; offline-capable via hdk-sync |
| `native/hdk-video-editor` | HDK · NEW | L · 5w | Shoheb | Trim, compress, watermark; offline-capable via hdk-sync |

---

## 4 · User stories

### As a **Vertical Product Engineer** (Healthcare team)
- **US-VE-1**: I model a patient visit as an Encounter with two participants (patient persona + doctor persona); per-encounter Vault key auto-issued; sealing the encounter shreds the key for retention.
- **US-VE-2**: I create a PCP Relationship between doctor and patient; ReBAC + Encounter Grants let the doctor read the patient's chart longitudinally.
- **US-VE-3**: My vertical's Activity model reuses sdk-engagement; no parallel visit/encounter primitive in my repo.

### As a **Vertical Product Engineer** (Realty team)
- **US-VE-4**: I model a property visit as Encounter with participants (agent + buyer + property); CRM Activity references encounter_id; no separate site-visit table.

### As a **ProjexCloud Operator**
- **US-OP-1**: A tenant connects their Salesforce org via OAuth in the Tenant Admin Portal; within 24h, 50k contacts mapped to Persona kind `salesforce_account`; sdk-crm shows them inline alongside native ProjexCloud contacts.
- **US-OP-2**: A tenant connects their Slack workspace; agents can post status updates to designated channels.

### As a **Tenant Admin**
- **US-TA-1**: I connect M365 in 3 clicks (OAuth) → Outlook events sync as Encounters of kind 'meeting'; SharePoint documents indexed via sdk-search; Teams used for cross-team approvals.
- **US-TA-2**: I connect Zendesk → existing tickets sync into sdk-service-request bidirectionally; my support team can keep using Zendesk while platform agents triage from one source of truth.
- **US-TA-3**: I create a marketing campaign in sdk-campaign — segment DSL filters by Persona kind + recent encounter activity; sends multi-channel notifications.

### As a **Tenant Employee** (CRM user)
- **US-EU-1**: I add a contact in sdk-crm; it's keyed by Persona; if the contact has a corresponding Salesforce account, the bidirectional sync ensures both sides stay current within 60s.
- **US-EU-2**: I take a photo with HDK camera (P4) and annotate it inline with hdk-image-editor; saved to sdk-evidence (P7 stub) with full provenance.

### As a **Tenant Developer** (building a custom app)
- **US-TD-1**: I subscribe my custom app to `engagement.encounter.closed.v1` via sdk-webhook; receive HMAC-signed events; my app updates a downstream system without polling.

---

## 5 · Functional requirements (per SDK / component)

### 5.1 · `@projexlight/sdk-engagement`

**Owns:**
- FR-EN-1: Encounter CRUD with states: `open → in-progress → closed → sealed`
- FR-EN-2: Encounter participants (typed persona refs with roles per encounter)
- FR-EN-3: Per-encounter Vault key open at encounter open; shred at seal
- FR-EN-4: Relationship CRUD + lifecycle (re-uses sdk-rebac engine)
- FR-EN-5: Encounter Grants (time/scope-bounded tokens for non-participants like consulting nurses)
- FR-EN-6: Encounter → extension hooks (chart, order, visit notes, capital call, etc. — vertical-specific extensions register here)
- FR-EN-7: Bills consuming SDKs through meter at encounter open/close

**Events:** `engagement.encounter.opened.v1` · `engagement.encounter.closed.v1` · `engagement.encounter.sealed.v1` · `engagement.relationship.created.v1` · `engagement.relationship.terminated.v1` · `engagement.encounter.grant.issued.v1`

**Pool placement:** App Pool (per tenant).

**SKUs:** `engagement.encounter.open` · `engagement.encounter.close` · `engagement.encounter.seal` · `engagement.relationship.create` · `engagement.encounter.grant.issue` — `tiered_per_call`.

### 5.2 · `@projexlight/sdk-crm`

**Owns:**
- FR-CRM-1: Contacts/Leads keyed by Persona (canonical)
- FR-CRM-2: Deal cycle = Engagement (deal stages map to encounter states)
- FR-CRM-3: CRM activities are sub-units of Engagement (no separate activity timeline)
- FR-CRM-4: Per-vertical custom_fields JSONB (typed via tenant-defined schemas in sdk-taxonomy)
- FR-CRM-5: Bidirectional sync target for connector-salesforce + connector-hubspot

**SKUs:** `crm.contact.create` · `crm.contact.update` · `crm.deal.transition` · `crm.activity.log` — `tiered_per_call`.

### 5.3–5.7 · sdk-content · sdk-service-request · sdk-event · sdk-campaign · sdk-social

(Each follows the SDK template with appropriate domain operations. Detailed FRs captured in engineering tickets.)

### 5.8 · `@projexlight/connector-salesforce`

**Owns:**
- FR-CSF-1: OAuth + org-install flow
- FR-CSF-2: Schema mapping: Account → Persona kind `salesforce_account`; Contact → Persona kind `salesforce_contact`; Lead → CRM Lead; Opportunity → CRM Deal (engagement)
- FR-CSF-3: Bidirectional sync: pull via Bulk API (initial) + Streaming/Change Data Capture (ongoing); push deltas via REST
- FR-CSF-4: Conflict policy per object (CRDT not generally applicable — prefer merge with timestamp tiebreak)
- FR-CSF-5: SOQL query helper for agent use (CapabilityGraph tool)
- FR-CSF-6: Webhook receiver for Streaming API events
- FR-CSF-7: Rate-limit handling per Salesforce daily API limits
- FR-CSF-8: Tool manifest exposed to agent CapabilityGraph (P6A): `salesforce.account.read` · `salesforce.contact.upsert` · `salesforce.opportunity.update` · `salesforce.soql.query`

**Pool placement:** `connector_salesforce` schema in Admin Pool (credentials, cursor state).

**SKUs:** `connector.salesforce.sync.record` · `connector.salesforce.api.call` · `connector.salesforce.soql.query` — `per_unit` (per-record sync; per-call query).

### 5.9 · `@projexlight/connector-microsoft365`

**Owns:**
- FR-CM3-1: Microsoft Graph OAuth + per-tenant app registration
- FR-CM3-2: SharePoint Drive enumeration; file read/write via Graph
- FR-CM3-3: Outlook: send mail, read calendar (with delegated permissions per Persona)
- FR-CM3-4: Teams: post messages, create meetings
- FR-CM3-5: OneDrive for personal storage of attachments
- FR-CM3-6: Per-user delegated tokens (when user has SSO via M365) + per-tenant application tokens for service operations
- FR-CM3-7: Tool manifest: `m365.email.send` · `m365.calendar.event.create` · `m365.sharepoint.file.read` · `m365.teams.message.post`

**SKUs:** Per-call + per-unit for bulk file operations.

### 5.10 · `@projexlight/connector-gworkspace` · `connector-jira` · `connector-linear` · `connector-zendesk` · `connector-hubspot` · `connector-zoom`

(Each follows the connector template; details captured in engineering tickets.)

### 5.11 · HDK scanner · image-editor · video-editor

Standard HDK template; offline-capable via hdk-sync; iOS + Android parity.

---

## 6 · Non-functional requirements

| Dimension | Target |
|---|---|
| Encounter open/close latency | ≤ 100ms p99 |
| Encounter seal + key shred | ≤ 1s p99 |
| Connector sync lag (webhook-driven) | ≤ 60s p99 |
| Connector sync lag (polling) | ≤ 5min p99 |
| CRM bidirectional Salesforce sync correctness | 100% (no orphaned records) |
| HDK image editor save (high-res) | ≤ 1s |
| HDK video editor trim (60s clip) | ≤ 10s |

---

## 7 · Acceptance criteria (the phase exit gate)

| # | Criterion | Owner | Test plan |
|---|---|---|---|
| **AC-1** | Encounter lifecycle round-trips: open → in-progress → closed → sealed | Engagement | Lifecycle integration test |
| **AC-2** | Encounter key shreds at seal; only sealed encounter undecryptable | Engagement | Chaos drill |
| **AC-3** | **Healthcare scenario**: visit lifecycle round-trips end-to-end with PCP relationship + encounter grant for nurse | Healthcare vertical + Engagement | End-to-end scenario test (see AIM §7.1) |
| **AC-4** | **eCommerce scenario**: order lifecycle round-trips | eCommerce vertical | End-to-end scenario test (see AIM §7.2) |
| **AC-5** | **Realty scenario**: site-visit round-trips with property + agent + buyer participants | Realty vertical | End-to-end scenario test |
| **AC-6** | CRM activities reference `encounter_id`; no parallel work-unit primitive invented in any vertical | Engagement | Lint check (forbids visit/order/session tables outside sdk-engagement) |
| **AC-7** | Six engagement SDKs each have end-to-end integration test | Platform | Test inventory |
| **AC-8** | **connector-salesforce**: connect Salesforce sandbox; sync 10k accounts within 1h; bidirectional update round-trips without conflict | Integrations | Sandbox integration test |
| **AC-9** | **connector-microsoft365**: send email via Outlook, create calendar event, post Teams message — all from one OAuth flow | Integrations | Vendor sandbox |
| **AC-10** | **connector-gworkspace**: same as M365 for Google Workspace | Integrations | Vendor sandbox |
| **AC-11** | **connector-jira** + **connector-linear**: bidirectional issue sync with sdk-service-request | Integrations | Vendor sandbox |
| **AC-12** | **connector-zendesk**: ticket sync bidirectional with sdk-service-request | Integrations | Vendor sandbox |
| **AC-13** | **connector-hubspot**: contact sync working in customers who stay on HubSpot | Integrations | Vendor sandbox |
| **AC-14** | **connector-zoom**: create meeting, fetch recording via webhook | Integrations | Vendor sandbox |
| **AC-15** | HDK scanner + image-editor + video-editor ship with iOS + Android parity | Mobile | CI matrix |
| **AC-16** | All P5 SDKs + connectors published as v1.0.0 | Platform | `npm view` |

---

## 8 · Test plan (selected)

### AC-3 · Healthcare visit lifecycle

**Scenario:** (From AIM §7.1)
1. Ravi (already a person) joins Hospital A as Patient persona
2. PCP Relationship between Dr. Smith and Ravi
3. Visit Encounter opened; Vault key issued
4. Dr. Smith reads chart (ReBAC via PCP relationship allows it)
5. Nurse joins via Encounter Grant scoped to chart.read + 8h TTL
6. Visit closed → key shred → all encounter-scoped data undecryptable

**Pass condition:** Every step audited; encounter key actually shredded; chart-read after seal returns Undecryptable; nurse grant auto-expires.

### AC-8 · Salesforce bidirectional sync

**Scenario:**
- Sandbox Salesforce org with 10k accounts pre-loaded
- Connect via OAuth from Tenant Admin → Connectors
- Initial bulk pull: 10k accounts mapped to Persona kind `salesforce_account` within 1h
- Update one Salesforce account → change propagates to ProjexCloud within 60s
- Update one ProjexCloud-side contact → change propagates to Salesforce within 60s
- Modify same record on both sides → conflict resolved per merge policy with timestamp tiebreak; audit captures both inputs

**Pass condition:** No orphaned records; conflict-resolution decisions all audited; OAuth refresh seamless.

---

## 9 · Dependencies

- ✅ P4 exit gate green
- ✅ sdk-connectors framework ready (P4)
- ✅ Vendor sandboxes for: Salesforce · M365 · GWorkspace · Jira · Linear · Zendesk · HubSpot · Zoom
- ✅ At least one vertical team ready to consume (Healthcare or Realty) for scenario tests

---

## 10 · Out of scope (deferred)

- ❌ AI Gateway / Agent Runtime — P6A
- ❌ MCP Bridge — P6A
- ❌ Semantic Domain Layer — P6B
- ❌ Snowflake / Iceberg — P6B / P7
- ❌ Field/evidence SDKs (Storm · Dispatch · Evidence) — P7

---

## 11 · Risks

| # | Risk | Severity | Likelihood | Mitigation |
|---|---|---|---|---|
| R-1 | Verticals invent their own visit/order/session entity instead of using Encounter | H | M | Lint ban (rule from Architecture §15 risks); Engagement is the only sanctioned home |
| R-2 | Connector OAuth flows are vendor-specific and brittle | M | H | Shared OAuth helper in framework; per-connector integration tests on every PR |
| R-3 | Salesforce daily API limit hit by aggressive sync | M | M | Adaptive throttling per tenant's Salesforce edition; alert at 70% of daily limit |
| R-4 | M365 / GWorkspace per-user vs per-tenant auth complexity | M | M | Documented authorization patterns; framework abstracts both |
| R-5 | Customer's Salesforce/HubSpot data format varies (custom fields per customer) | M | H | Per-tenant schema mapping config in Tenant Admin |
| R-6 | Bidirectional sync infinite loop (ProjexCloud updates SF → SF webhook back → ProjexCloud updates again) | H | M | Source-of-change tracking in sync engine; suppress own changes |
| R-7 | HDK editor save bypasses hdk-sync (direct write) | M | L | Lint blocks; framework enforces queue-first |

---

## 12 · Rollout plan

1. **Week 29–30**: sdk-engagement first (everything else depends on it)
2. **Week 30–34**: sdk-crm + sdk-content + sdk-service-request + sdk-event in parallel
3. **Week 31–34**: sdk-campaign + sdk-social
4. **Week 29–34**: Connector roster in parallel — Salesforce + M365 + GWorkspace are the long poles (5–6w)
5. **Week 30–34**: HDK editors in parallel
6. **Week 33**: Cross-vertical scenario tests (Healthcare visit · eCommerce order · Realty site-visit)
7. **Week 34**: Vendor-sandbox dress-rehearsals for each connector
8. **Week 35**: Phase exit-gate review

---

## 13 · Open questions / decisions needed

- [ ] Q-1: Encounter retention defaults per vertical — Healthcare 7y (HIPAA); Realty 5y; eCommerce 7y (financial)? — Working group decision
- [ ] Q-2: Connector schema-mapping default — auto-discover via vendor API + tenant approval? Or always tenant-defined?
- [ ] Q-3: HDK video-editor max file size — 500MB default; per-tier customer override?
- [ ] Q-4: Salesforce custom-object support — v1 maps standard objects only; custom objects in v1.1?

---

## 14 · Sign-off

| Role | Name | Date | Status |
|---|---|---|---|
| Phase DRI | Engagement WG + Integrations Lead | | |
| Platform Architect | Tanveer | | |
| Vertical Owners (Healthcare, Realty, eCommerce) | | | |
| Mobile Lead | Kunal | | |
