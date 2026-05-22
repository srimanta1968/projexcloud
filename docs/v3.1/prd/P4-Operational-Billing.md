# PRD · P4 — Operational Core + Billing + Integration Framework

| Field | Value |
|---|---|
| **Phase** | P4 |
| **Window** | Weeks 22–29 (~7 weeks) |
| **Maps to wave(s)** | W4 + HDK track |
| **Gates closed** | — (closes no new G; activates soft caps on meter) |
| **Status** | DRAFT |
| **Owner (DRI)** | Platform Engineering Lead |
| **Companion docs** | `../docs/v3.1/Architecture-v3.1.html` §10A · `../docs/v3.1/AgenticIntegration-v3.1.html` §5 |

---

## 1 · TL;DR

P4 turns the platform into a **billable, integrable, operationally complete** product. Operational SDKs (Media · Notification · Payment · Workflow · Search) all run through the meter and pool router. **Billing** generates first invoices using the catalog. **Webhook**, **Approval**, **Tenant Lifecycle** close the gaps every B2B SaaS hits. **sdk-connectors framework + connector-slack** opens the door to reaching customer's existing tools. HDK camera + map unlock field workflows. Meter switches from emit-only to soft caps (WARN headers).

---

## 2 · Why this phase now

Notification reads the App Identity's notification band (P3). Payment touches the Secure Data band (P3) and must envelope-encrypt via Vault (P1). Media stores blobs keyed by Vault tenant/encounter keys (P1) and ACL-checks via Policy (P2). Each is a thin SDK if the prior waves exist — and a multi-month refactor if they don't. Billing needs Payment (P4) to push invoices AND 20 weeks of accumulated meter events (P1+) for catalog calibration before the first real invoice. Tenant Lifecycle needs Billing to handle trial→paid conversion. The connectors framework lands here because customer integrations are needed from the moment the first vertical goes live (P5).

---

## 3 · What ships in this phase

| Component | Type | Effort | Owner | Notes |
|---|---|---|---|---|
| `@projexlight/sdk-media` | SDK · MODIFIED | M · 4w | Platform | Signed upload/download URLs · S3 prefix per tenant · envelope-encrypted blobs · transcoding pipeline · per-encounter blob keying |
| `@projexlight/sdk-notification` | SDK · MODIFIED | M · 4w | Platform | Channel routing (WhatsApp · SMS · email · push); template engine; provider abstraction (Twilio · SES · WhatsApp BSP); pre-flight Consent check; quiet hours; resolves App Identity notification-routing band (per-app) |
| `@projexlight/sdk-payment` | SDK · MODIFIED | L · 5w | Platform | Provider abstraction (Stripe · Razorpay · Plaid · ACH); PCI-tokenized refs in Secure Data; refund/chargeback workflow; immutable distribution ledger; respects encounter retention |
| `@projexlight/sdk-workflow` | SDK · NEW | M · 4w | Platform | Typed Temporal facade; durable workflow registry; compensable steps; envelope-context propagation through workers |
| `@projexlight/sdk-search` | SDK · MODIFIED | M · 3w | Platform | OpenSearch indexes per tenant; per-tenant aliases; ABAC-filtered queries; per-pool index sharding |
| `@projexlight/sdk-billing` | SDK · NEW v3.1 | L · 5w | Platform / Finance Eng | Reads ClickHouse rollups; applies versioned `pricing.catalog.vN`; monthly invoice gen; free-tier engine; soft/hard cap policy issuance to meter; dunning via sdk-workflow; showback/chargeback API per (app, BU, persona-kind, encounter); reprice-dry-run; customer-facing `/billing/live` |
| `@projexlight/sdk-webhook` | SDK · NEW v3.1 | M · 3w | Platform | Outbound delivery: per-tenant endpoint registry · event-type subscriptions · HMAC-signed payloads · exponential-backoff retries · DLQ · 30d replay UI · circuit breaker · mTLS option |
| `@projexlight/sdk-approval` | SDK · NEW v3.1 | M · 4w | Workflow / Platform | Generic approval-routing primitive · hierarchical chains · parallel approvals · auto-escalate on timeout · delegation rules · full audit per step; powers agent delegated-authority in P6A |
| `@projexlight/sdk-tenant-lifecycle` | SDK · NEW v3.1 | M · 4w | Platform | Full state machine: `provisioned → trial → active → suspended → offboarding → offboarded`; per-tenant sandbox sub-pool with masked PII; trial→paid conversion (sdk-billing); suspension; offboarding (export → grace → shred via sdk-data-rights → certificate) |
| `@projexlight/sdk-connectors` | SDK · NEW v3.1 | L · 5w | Integrations | Common framework: OAuth/credential management · typed schema mapping · bidirectional sync engine · rate-limit handling · webhook ingestion · polling fallback · cursor state · health monitoring |
| `@projexlight/connector-slack` | Connector · NEW v3.1 | M · 3w | Integrations | First connector; bidirectional Slack (sdk-notification has outbound; this adds inbound + interactive: read threads, slash commands, app shortcuts) |
| `native/hdk-camera` | HDK · NEW | L · 5w | Kunal | Native camera with provenance metadata; depends on hdk-permissions + hdk-diagnostic + **hdk-sync** + sdk-evidence stubs |
| `native/hdk-map` | HDK · NEW | L · 5w | Satyam | Native map with permissions; depends on hdk-permissions + sdk-geo |
| **Meter mode switch** | Config change | — | Platform | Emit-only → soft caps (WARN headers on responses; logged but not denied) |
| `apps/projexcloud-admin` (MVP) | Portal | M · 4w | Platform | First customer-facing version: Tenant Management · Billing Operations · Pool Health · early agent ops surfaces |
| `apps/tenant-admin` (MVP) | Portal | M · 4w | Platform | First version: Users/Personas · API Keys · Webhooks · Billing & Usage · Audit Read · Custom App registry |

---

## 4 · User stories

### As a **Platform Engineer**
- **US-PE-1**: I add a `@meter` decorator to a new method; soft-cap responses now include a `X-Projex-Quota-Remaining` header so client apps can warn the user.
- **US-PE-2**: I trigger a workflow via sdk-workflow; envelope context (tenant + persona + trace_id) propagates through all worker steps automatically.
- **US-PE-3**: I publish an event of type `engagement.encounter.created.v1` and sdk-webhook fans out to every subscribed tenant endpoint with HMAC signatures.

### As a **ProjexCloud Operator**
- **US-OP-1**: I run a synthetic 30-day usage test for a test tenant; T+24h after month close, an invoice is generated; line items per SDK per method match the meter rollup byte-perfect.
- **US-OP-2**: I run a reprice-dry-run on the same month under `pricing.catalog.v2`; the delta report shows per-tenant impact before I apply the new catalog.
- **US-OP-3**: I onboard a new tenant via the Tenant Lifecycle SDK: pool allocation → sample data → welcome notifications → all happens in <5 minutes self-serve.
- **US-OP-4**: I offboard a tenant: data export delivered → grace period → cryptographic shred → certificate of destruction. The whole flow takes <30 days with auditable proof.

### As a **Tenant Admin**
- **US-TA-1**: I see my tenant's current month usage in real-time at `/billing/live` — split by app, BU, persona-kind. Surprises don't compound silently.
- **US-TA-2**: I configure my Slack workspace as a connector; my custom AI agent (built in P6A) can post messages and read threads on my behalf.
- **US-TA-3**: I register a webhook endpoint for `payment.charged.v1` events; HMAC signature on every delivery; failed deliveries retry with backoff and surface in a DLQ I can replay.
- **US-TA-4**: I configure an approval chain: refunds > $10k require Director then VP approval; sdk-approval auto-escalates on timeout.

### As a **Tenant Developer**
- **US-TD-1**: My custom app posts a message to my customer's Slack workspace using `connector-slack` — auth + rate limits + retries handled by the framework; my code is one line.

### As a **Tenant Employee** (field worker)
- **US-EU-1**: I use the HDK camera to capture evidence in the field; metadata (GPS, device_uuid, timestamp) is stamped automatically; offline-write queues via hdk-sync; conflicts with another worker's edits resolved on reconnect.

### As a **Customer Success Manager**
- **US-CSM-1**: I see Tier-G tenant's billing dashboard in the ProjexCloud Admin Portal; cost trend over time; per-SDK cost split.

---

## 5 · Functional requirements (per SDK / component)

### 5.1 · `@projexlight/sdk-media`

**Owns:**
- FR-MED-1: Signed upload URLs scoped per tenant (S3 prefix)
- FR-MED-2: Envelope-encrypted blobs (per-tenant key from Vault; per-encounter key when encounter-bound)
- FR-MED-3: Transcoding pipeline (video → MP4 + HLS, image → optimized formats); jobs metered
- FR-MED-4: Signed playback URLs with TTL
- FR-MED-5: Per-encounter blob keying when applicable; sealed encounters block new evidence

**Database / storage:** `media` schema in Admin Pool (metadata only) + S3.
**SKUs:** `media.upload` (per-MB) · `media.transcode` (per-minute) · `media.playback.signed-url` (flat) — `per_unit`.

### 5.2 · `@projexlight/sdk-notification`

**Owns:**
- FR-NTF-1: Multi-channel routing (WhatsApp · SMS · email · push)
- FR-NTF-2: Provider abstraction (Twilio · SES · WhatsApp BSP · APNs · FCM · Slack outbound)
- FR-NTF-3: Template engine with i18n + per-tenant overrides
- FR-NTF-4: Send pre-flight consent check (sdk-consent)
- FR-NTF-5: Quiet hours per persona; do-not-disturb rules
- FR-NTF-6: Notification-routing band lookup via sdk-identity-resolver (per-app)

**Events:** `notification.sent.v1` · `notification.delivered.v1` · `notification.failed.v1`
**SKUs:** `notification.send.{channel}` — `passthrough_plus_margin` (provider cost + margin).

### 5.3 · `@projexlight/sdk-payment`

**Owns:**
- FR-PAY-1: Provider abstraction (Stripe · Razorpay · Plaid · ACH)
- FR-PAY-2: PCI-tokenized refs stored in Secure Data band (NEVER raw PAN)
- FR-PAY-3: Refund / chargeback workflow with sdk-approval gates for high-value
- FR-PAY-4: Immutable distribution ledger (event-sourced) for fund-use cases
- FR-PAY-5: Respects encounter retention (invoices belonging to sealed encounter retained per encounter's retention class)

**Events:** `payment.charge.v1` · `payment.refund.v1` · `payment.distributed.v1`
**SKUs:** `payment.charge` · `payment.refund` · `payment.distribute` — `tiered_per_call` (volume rewards).

### 5.4 · `@projexlight/sdk-workflow`

**Owns:**
- FR-WFL-1: Typed Temporal facade with envelope-context propagation
- FR-WFL-2: Durable workflow registry (every workflow definition registered + versioned)
- FR-WFL-3: Compensable steps (define + rollback per step)
- FR-WFL-4: One Temporal namespace per pool family (per-pool isolation)
- FR-WFL-5: Workflow query API for inspection

**SKUs:** `workflow.start` · `workflow.signal` · `workflow.query` · `workflow.step.execute` — `flat_per_call`.

### 5.5 · `@projexlight/sdk-search`

**Owns:**
- FR-SRC-1: OpenSearch indexes per tenant
- FR-SRC-2: Per-tenant aliases
- FR-SRC-3: ABAC-filtered queries (effective_scopes from resolver applied at query time)
- FR-SRC-4: Index-builder helpers (auto-indexes from SDK events)
- FR-SRC-5: Saved query primitives
- FR-SRC-6: Per-pool index sharding

**SKUs:** `search.query` · `search.index` — `tiered_per_call`.

### 5.6 · `@projexlight/sdk-billing`

**Owns:**
- FR-BIL-1: Pricing catalog schema (in contracts) + rates (in Postgres, editable by Finance)
- FR-BIL-2: Monthly invoice generation (PDF + per-SKU line items)
- FR-BIL-3: Free-tier engine, committed-use discounts, soft/hard cap policy → meter
- FR-BIL-4: Dunning workflow (composes sdk-workflow + sdk-notification)
- FR-BIL-5: Showback / chargeback API per `(app_id, bu_id, persona_kind, encounter_id)` — the wedge vs hyperscalers
- FR-BIL-6: Reprice-dry-run job (any past month, any catalog version)
- FR-BIL-7: Customer-facing real-time meter dashboard at `/billing/live`
- FR-BIL-8: Push invoices to Stripe / Razorpay via sdk-payment

**Pricing modes supported:** flat_per_call · tiered_per_call · passthrough_plus_margin · per_unit · bundled_subscription+overage · free_internal

**SKUs:** `billing.invoice.generate` · `billing.reprice.dry-run` · `billing.showback.query` — internal.

### 5.7 · `@projexlight/sdk-webhook`

**Owns:**
- FR-WHK-1: Per-tenant endpoint registry with event-type subscriptions
- FR-WHK-2: HMAC-SHA256 signed payloads (signing keys vaulted)
- FR-WHK-3: Exponential-backoff retries (5 attempts default; configurable)
- FR-WHK-4: Dead-letter queue with 30-day replay UI in Tenant Admin
- FR-WHK-5: Circuit breaker per endpoint (open after N failures; half-open retry)
- FR-WHK-6: mTLS option for high-trust endpoints
- FR-WHK-7: Per-pool outbox + per-pool delivery workers
- FR-WHK-8: Compose with EventTypeRegistry (only registered events can be subscribed)

**SKUs:** `webhook.endpoint.register` · `webhook.delivery` — `tiered_per_call`.

### 5.8 · `@projexlight/sdk-approval`

**Owns:**
- FR-APP-1: Approval-route primitive (define chain of approvers by role)
- FR-APP-2: Hierarchical chains (Manager → Director → VP)
- FR-APP-3: Parallel approvals (M-of-N approval)
- FR-APP-4: Auto-escalate on timeout per SLA
- FR-APP-5: Delegation rules (out-of-office, role inheritance)
- FR-APP-6: Full audit per step + reason capture
- FR-APP-7: Composable into any vertical workflow (refunds, mass-delete, cross-tenant share, agent beyond-scope in P6A)

**SKUs:** `approval.route.create` · `approval.step.execute` · `approval.timeout.escalate` — `flat_per_call`.

### 5.9 · `@projexlight/sdk-tenant-lifecycle`

**Owns:**
- FR-TLC-1: State machine: `provisioned → trial → active → suspended → offboarding → offboarded`
- FR-TLC-2: Provisioning workflow (pool alloc, default policies, sample data, welcome notifications)
- FR-TLC-3: Sandbox sub-pool per tenant with masked PII; refresh-from-prod with consent
- FR-TLC-4: Trial → paid conversion (sdk-billing integration)
- FR-TLC-5: Suspension (read-only mode for non-payment)
- FR-TLC-6: Offboarding (export-all → grace → shred via sdk-data-rights → certificate)
- FR-TLC-7: Reseller-attached tenants honor reseller's offboarding policy

**Events:** `tenant.lifecycle.transitioned.v1` (with from/to state + reason)
**SKUs:** `tenant.provision` · `tenant.suspend` · `tenant.offboard` · `tenant.sandbox.create` — `flat_per_call`.

### 5.10 · `@projexlight/sdk-connectors` framework

**Owns:**
- FR-CON-1: OAuth/credential management (vaulted per-tenant; refresh tokens; scope tracking)
- FR-CON-2: Typed schema mapping primitives (source → canonical; conflict resolution per §6A)
- FR-CON-3: Bidirectional sync engine (CDC from source; delta push back; replay-safe)
- FR-CON-4: Rate-limit handling (backoff, jitter, per-tenant quota respect)
- FR-CON-5: Webhook ingestion adapter (inbound from external systems via sdk-webhook)
- FR-CON-6: Polling fallback for systems without webhooks
- FR-CON-7: Cursor/checkpoint state durable in connector's schema; survives restarts
- FR-CON-8: Health monitoring (per-connection status, error budgets, alerting)

**SKUs:** `connector.connect` · `connector.sync.record` · `connector.poll.cycle` — `flat_per_call` + `per_unit` for high-volume sync.

### 5.11 · `@projexlight/connector-slack` (first connector)

**Owns:**
- FR-SLK-1: OAuth + workspace install
- FR-SLK-2: Read channels + threads
- FR-SLK-3: Post messages + interactive components (buttons, modals)
- FR-SLK-4: Slash command + app shortcut handlers
- FR-SLK-5: Webhook ingestion of Slack events (member_joined, message, reaction)
- FR-SLK-6: Tool manifest for agent CapabilityGraph (P6A consumes)

**SKUs:** `slack.message.post` · `slack.thread.read` · `slack.event.ingest` — `flat_per_call`.

### 5.12 · HDK camera + map

Standard HDK modules — TS facade + iOS + Android natives; depend on hdk-permissions + hdk-sync + hdk-diagnostic.

---

## 6 · Non-functional requirements

| Dimension | Target |
|---|---|
| Notification provider failover | ≤ 5s |
| Payment provider failover | per provider — Stripe-only failover within 30s |
| Workflow envelope-context propagation | 100% (CI verified) |
| Search ABAC-filter accuracy | 100% (no over-permissive results) |
| Invoice generation latency | T+24h after month close |
| Webhook delivery success rate | ≥ 99.9% (after retries within DLQ window) |
| Approval routing SLA | per-route configurable; default escalation ≤ 4h |
| Tenant lifecycle: provision → first login | ≤ 5 minutes |
| Tenant offboarding: request → cert | ≤ 30 days (per DSAR SLA) |
| Connector sync lag (Salesforce, Slack) | ≤ 60s p99 (with webhook); ≤ 5min (polling fallback) |
| HDK camera p99 capture-to-save | ≤ 500ms |
| Meter soft-cap WARN header latency | ≤ 2ms (added to existing gate budget) |

---

## 7 · Acceptance criteria (the phase exit gate)

| # | Criterion | Owner | Test plan |
|---|---|---|---|
| **AC-1** | All operational SDKs run only via Pool Router | Platform | CI rule + integration test |
| **AC-2** | Notification + Consent + Profile happy-path: sending requires consent; routing reads only L2 band | Platform | End-to-end test |
| **AC-3** | Payment + Vault PCI happy-path: charge → tokenize → store in Secure Data; no raw PAN in any log | Platform | Compliance scan |
| **AC-4** | Media envelope-encrypted upload + signed playback round-trip | Platform | Integration test |
| **AC-5** | Temporal workflow with envelope propagation through 3 worker steps | Platform | Integration test |
| **AC-6** | Search with ABAC filtering returns only authorized results | Platform | ABAC scenario test |
| **AC-7** | **Billing:** synthetic tenant runs 30 days of W2/W3 traffic → T+24h invoice generated against `pricing.catalog.v1`; line items reconcile against meter rollups | Platform / Finance | End-to-end billing test |
| **AC-8** | Reprice-dry-run under `catalog.v2` produces a consistent delta report | Finance | Comparison test |
| **AC-9** | Showback API splits per-app/BU/persona; splits sum to total | Finance | API verification |
| **AC-10** | Meter **soft caps** emit WARN headers without denying | Platform | Load test |
| **AC-11** | First invoice pushed to Stripe in sandbox | Platform / Finance | Vendor sandbox test |
| **AC-12** | **Webhook:** delivers HMAC-signed events with retry + DLQ verified | Platform | Synthetic delivery test |
| **AC-13** | **Approval:** routes synthetic refund > $10k through Manager → Director chain with SLA escalation | Platform | End-to-end approval test |
| **AC-14** | **Tenant Lifecycle:** provisions a new tenant end-to-end + offboards another tenant cleanly (export → grace → shred → certificate) | Platform | End-to-end lifecycle test |
| **AC-15** | **sdk-connectors framework + connector-slack:** ingest Slack thread message as `slack.thread.message.v1` event; agent (P6A stub) can post via connector-slack with capability token; OAuth refresh + revocation verified | Integrations | End-to-end Slack test |
| **AC-16** | HDK camera + map ship with iOS + Android parity verified by CI matrix; capture+save p99 ≤ 500ms; offline-write goes through hdk-sync | Mobile | Cross-platform CI |
| **AC-17** | ProjexCloud Admin Portal MVP usable: Tenant Management · Billing Ops · Pool Health surfaces functional | Platform | UX walk-through |
| **AC-18** | Tenant Admin Portal MVP usable: Users · API Keys · Webhooks · Billing & Usage · Audit Read · Custom App registry functional | Platform | UX walk-through |
| **AC-19** | All P4 SDKs + connector-slack published as v1.0.0 to private registry | Platform | `npm view` |

---

## 8 · Test plan (selected)

### AC-7 · End-to-end billing

**Scenario:**
1. Provision synthetic tenant `ten_test_billing` in week 22; clone production-like traffic shape
2. Replay 30 days of traffic through all P2/P3/P4 SDKs (compressed to 3 hours in test)
3. ClickHouse rollups populate with usage events tagged per SKU
4. On month-close cron, sdk-billing reads rollups → applies `pricing.catalog.v1` → generates invoice (PDF)
5. Invoice line items reconciled against raw event counts: byte-perfect

**Pass condition:** Invoice generated within 24h of cron trigger; reconciliation diff = 0; PDF rendered cleanly; SKUs all priced.

### AC-13 · Approval routing

**Scenario:**
- Synthetic refund request for $15,000 submitted by Customer Service persona
- sdk-approval routes to Manager (4h SLA) → Director (4h SLA) → VP (immediate auto-approve based on rule)
- Test 1: Manager approves within SLA → routes to Director
- Test 2: Manager doesn't approve → auto-escalates to Director after 4h
- Test 3: Whole chain completes within 12h

**Pass condition:** All routing decisions audited; SLA timers respected; notification fires at each step; final decision recorded in payment ledger.

### AC-15 · Slack connector end-to-end

**Scenario:**
1. Tenant admin clicks "Connect Slack" in Tenant Admin → OAuth flow → workspace installed
2. Test channel `#proxlight-test` configured; webhook subscription on `message` events
3. Send 5 messages in Slack → 5 `slack.thread.message.v1` events appear in tenant's event stream within 60s
4. Agent (stub for P6A) attempts to post a message via `connector-slack` with capability token scoping it to `#proxlight-test` only
5. Post succeeds; attempt to post to `#general` (out of scope) denied
6. Rotate OAuth token → next API call refreshes seamlessly; revoke → next call fails with clear error

**Pass condition:** All steps complete; audit chain includes connector-id + tool-id per call; meter records cost.

### AC-14 · Tenant lifecycle end-to-end

**Scenario:**
- Provision tenant `ten_test_lifecycle` → pool allocated → sample data seeded → admin user invited via welcome email
- Tenant uses platform for 7 days (simulated)
- Tenant requests offboarding → export bundle generated (Profile + Persona + Engagement + Audit subset) → 7-day grace → shred via sdk-data-rights → certificate of destruction signed by Audit
- Verify: no residual data in any pool

**Pass condition:** Provisioning <5min; offboarding completes with cert + zero residual data verified by reconciliation.

(AC-10, AC-12, AC-16, AC-17, AC-18 captured in engineering tickets.)

---

## 9 · Dependencies

- ✅ P3 exit gate green
- ✅ Identity Resolver + projection running smoothly
- ✅ hdk-sync available (P3) — required by hdk-camera + hdk-map
- ✅ Vault tier hierarchy stable
- ✅ Vendor sandbox accounts: Stripe · Slack · Twilio · Razorpay · SendGrid

---

## 10 · Out of scope (deferred)

- ❌ Engagement (Encounter + Relationship CRUD) — P5
- ❌ CRM, Content, Service Request, Event, Campaign, Social — P5
- ❌ Salesforce, M365, GWorkspace, Jira, etc. connectors — P5
- ❌ AI Gateway + Agent Runtime — P6A
- ❌ MCP Bridge — P6A
- ❌ Semantic, Lineage, Conversation — P6B
- ❌ Hard meter caps (DENY) — P7

---

## 11 · Risks

| # | Risk | Severity | Likelihood | Mitigation |
|---|---|---|---|---|
| R-1 | Billing catalog drift breaks invoices | H | M | SKU schema in contracts (CI catches dangling refs); orphan-SKU lint; reprice-dry-run mandatory |
| R-2 | Webhook delivery overwhelms tenant endpoints | M | M | Circuit breaker per endpoint; per-tenant rate limits; backoff defaults |
| R-3 | Approval routing complexity (corner cases: delegation chains, out-of-office, role changes mid-flight) | M | M | Comprehensive scenario tests; conservative defaults (escalate on ambiguity) |
| R-4 | Connector OAuth refresh-token expiration silently breaks sync | M | M | Health monitoring per connection; alert at T-7 days from refresh-token expiry; auto-re-prompt user via webhook |
| R-5 | HDK camera large-file upload competes with hdk-sync queue priority | M | M | Priority queue in hdk-sync; camera uploads marked low-priority by default |
| R-6 | Soft cap WARN headers confuse client apps that don't handle them | L | M | Documentation; defaults are inert; opt-in WARN parsing |
| R-7 | Tenant Lifecycle sandbox refresh-from-prod leaks PII via masking failure | H | L | Multi-layer PII masking (column-level + row-level + audit); CI tests sandbox cleanliness |

---

## 12 · Rollout plan

1. **Week 22–24**: Operational core (Media · Notification · Payment · Workflow · Search) in parallel
2. **Week 24–27**: sdk-billing (5w; needs catalog calibration data from prior phases)
3. **Week 24–27**: sdk-webhook · sdk-approval · sdk-tenant-lifecycle in parallel
4. **Week 24–28**: sdk-connectors framework + connector-slack
5. **Week 22–27**: HDK camera + map (must wait for hdk-sync from P3)
6. **Week 25**: Meter soft-cap mode activated in dev region
7. **Week 26**: ProjexCloud Admin + Tenant Admin Portal MVPs deployed
8. **Week 27**: End-to-end billing dress-rehearsal (synthetic tenant, full month)
9. **Week 28**: Slack connector dress-rehearsal with real Slack workspace
10. **Week 29**: Phase exit-gate review; P5 unblocked

---

## 13 · Open questions / decisions needed

- [ ] Q-1: Default soft-cap thresholds — 80% of monthly quota? Per-tenant configurable
- [ ] Q-2: Webhook signing algorithm — HMAC-SHA256 standard; allow HMAC-SHA512 opt-in?
- [ ] Q-3: Approval default escalation SLA — 4h business hours? Or 24h with weekend skipping?
- [ ] Q-4: Sandbox PII masking algorithm — Faker.js default? Per-vertical custom?
- [ ] Q-5: Slack connector default scopes — channels:history, chat:write, commands; document the OAuth-scope-minimization principle
- [ ] Q-6: Billing invoice currency — base currency from FiscalPeriod (P2); multi-currency invoices in P6B (with Iceberg consolidation)? Or earlier?

---

## 14 · Sign-off

| Role | Name | Date | Status |
|---|---|---|---|
| Phase DRI | Platform Engineering Lead | | |
| Platform Architect | Tanveer | | |
| Finance Engineering | TBD | | |
| Mobile Lead | Kunal | | |
| Integrations Lead | TBD | | |
