# ProjexCloud Admin — Platform Operator Guide

> **New:** Start with [onboarding-overview](onboarding-overview.html) for the three-portal model and identity model. Persona onboarding guides (Word + HTML) live in this folder. This page is the detailed operator reference.

**Audience:** ProjexCloud platform staff (SRE, support, finance, compliance).
**URL (dev):** `http://localhost:3100`
**Backed by:** api-gateway on `http://localhost:3500` via `/admin/*` routes,
guarded by the `ADMIN_OPS_TOKEN` header.

This console is **cross-tenant**. Every action you take here is recorded in the
platform's hash-chained audit ledger; the tenant whose data you touched will be
able to see the entry in their Tenant Admin console.

---

## 1. Tenants — provision, browse, lifecycle

### 1.1 Provision a new tenant

**Why:** A new customer signed a contract, or you need a sandbox/demo tenant.

**When:** As soon as the App and (optionally) Reseller records exist. You cannot
provision a tenant without an `app_id` — the App is the parent product surface.

**Steps:**
1. Click **Tenants** → **+ New tenant**.
2. Fill the form:
   - **App ID** — UUID of the parent App (`tenant.app` row). Required.
   - **Display name** — what the customer sees in their workspace.
   - **Region** — cloud region (`us-east-1`, `eu-west-1`, etc.). Must align
     with any sovereign residency policy you'll attach later.
   - **Isolation tier:**
     - `S` (shared) — default. Tenant shares admin + app pools with others.
     - `P` (premium) — dedicated app pool.
     - `G` (gov / sovereign) — fully isolated. Pair with a Sovereign Region.
   - **Brand domain** (optional) — vanity hostname.
3. Submit. You'll land back on the Tenants list and see the new row in
   status `provisioned`.

**Post-check:**
- Open the **Audit** page, filter by the new `tenant_id` — you should see
  `tenant.created.v1` and `tenant.pool.assigned.v1` entries.
- The tenant is now reachable in Tenant Admin (`localhost:3200`) with that
  tenant_id, but no members exist yet. Onboard the first admin separately
  via the members API or hand off the tenant_id to the customer's IT lead.

### 1.2 Suspend / reinstate / offboard

The Tenants table is read-only for browsing. State changes go through the
Tenant Lifecycle SDK endpoints:

| Action | Endpoint | When |
|---|---|---|
| Suspend | `POST /api/tenant-lifecycle/:tenant_id/suspend` | Non-payment, abuse, breach hold. Requires a `reason`. |
| Reinstate | `POST /api/tenant-lifecycle/:tenant_id/reinstate` | After suspend is resolved. Only valid from `suspended`. |
| Offboard | `POST /api/tenant-lifecycle/:tenant_id/offboard` | Customer leaves. Triggers a 30-day grace clock by default; data is shredded at `deadline_at`. |
| State check | `GET  /api/tenant-lifecycle/:tenant_id/state` | Read-only. |

These currently need a tenant-scoped JWT; the UI buttons for them are on the
roadmap.

---

## 2. Pools — capacity and routing

**Why:** Every tenant request is routed to a numbered admin pool and an app pool
keyed by module. Pools are how we isolate noisy neighbours, run sovereign
deployments, and roll capacity.

**When to look here:**
- A tenant is being throttled — check the pool's status (`active` /
  `degraded` / `drain`).
- You're rolling capacity — `drain` a pool, wait for tenants to redirect, then
  recycle.
- A pool's Postgres replica is lagging — flip status to `degraded` so the route
  cache reroutes new traffic; existing connections finish.

**Steps to flip a pool:**
1. **Pools** → click the pool index.
2. Confirm the current status and tenant count.
3. Submit the status change. The pool router pushes the flip onto Redis
   `pool:status-flip`; every gateway instance updates its in-memory route cache
   within the TTL window (`ROUTE_CACHE_TTL_MS`, default 5 min).

**Post-check:** the Audit chain shows `pool.status.flipped.v1`, and `pools` on
this page reflects the new state.

---

## 3. Pricing catalogs — SKUs + soft caps

**Why:** Every metered unit (API call, MB processed, AI token) is priced through
a catalog. Catalogs version-bump on every published change; old invoices keep
pointing at the version they were finalized against.

**Sections:**
- **Pricing catalogs** — the list page; one row per catalog.
- Click a catalog → per-SKU rate table + a status flip (`draft` → `published`
  → `archived`).
- **Soft caps** — within a catalog, a SKU can have a per-tenant ceiling. Hitting
  the soft cap stamps a `WARN` header on the response and surfaces in the
  tenant's billing page; it doesn't block.

**Common workflows:**
- *Quarterly price bump:* clone the current catalog, edit rates, publish.
  Existing tenants stay on the old version until you migrate them.
- *Add a new SKU:* publish a new catalog version with the SKU + rate.
- *Investigate a soft-cap alarm:* on the tenant's row, check the
  `current_usage` resolver and the cap level.

---

## 4. Invoices

**Why:** Read-only viewer for the platform's invoice ledger. Use this to:
- Answer a customer's "where did this charge come from?" ticket.
- Reconcile against the upstream payment provider (Stripe today).
- Spot anomalies (sudden 10× usage on a tenant).

**Steps:**
1. **Invoices** → enter `tenant_id` to filter.
2. Click an invoice → line-item breakdown by SKU + the catalog version that
   priced it.

There are no destructive actions here — refunds and credits go through the
payment provider, not this UI.

---

## 5. Webhooks — DLQ replay

**Why:** When a tenant's webhook endpoint times out or returns 5xx, the delivery
lands in the Dead Letter Queue. Operators replay individual deliveries (e.g.
after the tenant tells you they fixed their handler).

**Sections:**
- **Webhooks** — list of every configured webhook subscription across all
  tenants.
- **Webhooks → DLQ** — failed deliveries, newest first.

**Steps to replay:**
1. **Webhooks → DLQ** → find the delivery (search by tenant or event type).
2. Click **Replay**. The gateway re-posts the original payload to the
   subscription URL with the same signature. Outcome lands back in the DLQ if
   it fails again.

**When NOT to replay:** if the tenant has rotated their endpoint secret since
the original delivery, the signature won't validate. Ask them to either accept
the old signature briefly or treat the events as lost.

---

## 6. Approvals — routes + pending requests

**Why:** Some destructive or high-risk actions (e.g., bulk data export, BYOK
key rotation, sovereign region creation) require an explicit operator approval
before they execute. This page is the operator's queue.

**Sections:**
- **Approvals** — pending requests across all tenants.
- **Approvals → Breaches** — requests that exceeded their SLA without a
  decision (paged so on-call can chase).

**Steps:**
1. **Approvals** → click a request.
2. Review the requestor, the action, and the linked artifacts.
3. Approve or Reject — both write to the audit chain and notify the requestor.

---

## 7. Audit — hash-chain browser

**Why:** Every state change in the platform writes a row to the per-tenant audit
ledger, chained by SHA-256 hash. This page is the operator's
forensic / compliance lens.

**Workflows:**
- *Customer asks "who changed X on date Y?":* filter by `tenant_id` + date
  range, optionally narrow by `actor_id`.
- *Compliance attestation:* enter a `tenant_id` and click **Verify**. The
  gateway walks every chain block since the last attested checkpoint and
  confirms hashes match. A green result is what auditors want to see.
- *Incident post-mortem:* paste an `actor_id` (a service or persona) and review
  every action it took in the window.

**Important:** never edit audit rows. If a row is wrong, write a compensating
event — never UPDATE.

---

## 8. Sovereign regions

**Why:** Some tenants (gov, EU/EEA, healthcare) must run inside a sovereign
region with hard data-residency guarantees. This page enumerates the regions,
their jurisdictional rules, and which tenants are attached.

**Steps to add a region:**
1. **Sovereign** → fill the form (region code, jurisdiction, residency class,
   key-management profile).
2. Submit. The region becomes selectable when provisioning a `G`-tier tenant.

**Post-check:** new tenants in that region should emit
`sovereign.region.attached.v1`. The watcher worker
(`SOVEREIGN_EXPIRY_WATCHER_ENABLED`) will alert if a tenant later drifts
out of residency.

---

## 9. On-Prem installs

**Why:** Customers running ProjexCloud inside their own data centre register
their install fingerprint here so the SaaS control plane can ship them updates,
fetch heartbeats, and prove their LLM probe is green.

**Common workflows:**
- *Register an install:* customer runs the bootstrap, then you confirm the
  install_id + license here.
- *Heartbeat investigation:* if an install's heartbeat goes silent, this page
  flags it red. Cross-check with `ONPREM_LLM_PROBE_ENABLED` alerts.

---

## 10. Active-Active

**Why:** Multi-region active-active deployments require a periodic drill to
prove failover works. This page is where you launch the drill, watch replica
lag, and review the last drill report.

**Steps:**
1. **Active-Active** → confirm both replicas are healthy.
2. Click **Run drill**. Reads start hitting both, writes are forced through the
   secondary briefly, replica lag is measured.
3. Review the report. Any lag > 5 s during the drill is a yellow flag; a
   replica refusing writes is a red flag.

**When NOT to run:** during a known incident, when one replica is already
behind. Wait for green.

---

## Operational reference

| Concept | Where it lives |
|---|---|
| Audit chain | `sdk-audit` — per-tenant Postgres tables |
| Pricing catalogs | `sdk-meter` — `meter.pricing_catalog*` |
| Pools | `sdk-pool-router` — `pool.pool` + Redis `pool:status-flip` |
| Webhooks DLQ | `sdk-webhook` — `webhook.dlq` |
| Tenant lifecycle | `sdk-tenant-lifecycle` — state machine `provisioned → trial → active → suspended/offboarding → offboarded` |
| Sovereign | `sdk-sovereign` — `sovereign.region`, `sovereign.tenant_attachment` |

---

## Troubleshooting

**The page shows "No tenants" but I know there are some.**
The portal can't reach the gateway. Check:
- `apps/projexcloud-admin/.env.local` → `NEXT_PUBLIC_GATEWAY_URL` matches the
  gateway's `PORT`.
- `ADMIN_OPS_TOKEN` is set identically in both `.env.local` and the gateway's
  `.env`.
- Gateway logs show no 401s for `x-admin-ops-token`.

**Provisioning a tenant fails with `foreign key`.**
The `app_id` you entered does not exist in `tenant.app`. Create the App first.

**Audit verify shows a broken chain.**
Stop everything and page the platform lead. A broken hash chain means either
a write went around `sdk-audit` (forbidden) or the table was edited directly
(forbidden). Never "fix" the chain by re-hashing — investigate the root cause.
