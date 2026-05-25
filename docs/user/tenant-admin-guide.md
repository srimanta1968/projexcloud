# Tenant Admin — Tenant Operator Guide

**Audience:** A customer's tenant administrator (the person who owns the
tenant inside their company — usually IT lead, RevOps lead, or a delegated
admin persona).
**URL (dev):** `http://localhost:3200`
**Backed by:** api-gateway on `http://localhost:3500` via `/api/*` routes,
authenticated with the admin's tenant-scoped JWT.

This console is **scoped to your tenant only**. You cannot see or affect
other tenants. Everything you do here writes to your tenant's audit ledger,
which ProjexCloud platform staff (and your own auditors) can verify.

---

## 1. Billing

**Why:** Show your finance team what the tenant is spending in near real-time,
plus a historical invoice archive.

**Sections on this page:**
- **Live meter** — current period's accrued usage by SKU. Refreshes every
  ~60 s from `sdk-meter`.
- **Invoices** — finalized invoices, newest first. Each links to a PDF +
  CSV export.
- **Showback** — per-BU (business unit) breakdown of usage; useful for
  internal chargeback.

**Common workflows:**
- *Monthly close:* download the latest invoice PDF and reconcile against
  your AP system.
- *Overage investigation:* if the live meter is climbing faster than expected,
  click the SKU → see which API keys / personas drove the traffic.
- *Cap warning:* if a SKU shows a yellow "soft-cap exceeded" badge, you've
  passed a Finance-defined threshold. Requests still succeed, but a `WARN`
  header is being stamped on responses. Talk to your ProjexCloud rep about
  raising the cap or moving to a higher plan.

---

## 2. Members — personas, roles, BUs

**Why:** Add and manage humans (and service accounts) inside your tenant.
A *persona* is the assignable identity; a *role* maps the persona to a set
of permissions; a *BU* (business unit) lets you group personas for billing
and approvals.

**Steps to add a teammate:**
1. **Members** → **Add persona**.
2. Pick *kind*:
   - `human` — invite by email; they'll receive a sign-in link.
   - `service` — generates a service-account persona; pair with an API key.
3. Assign one or more roles. Roles are templated from your App's
   role-template catalogue (set up by ProjexCloud during onboarding).
4. (Optional) Pick a BU.
5. Save. The persona is created with no active sessions; the human flow
   needs them to click the invite.

**Steps to revoke access:**
1. Find the persona in the table.
2. Click **Revoke**. All sessions invalidate immediately; any open
   websocket connections close.

**Steps to add a BU:**
1. **Members** → **Business units** tab → **+ New BU**.
2. Pick a parent BU (or leave blank for top-level) + name + kind (e.g.
   `cost-center`, `region`).
3. Save. Existing personas can be moved into the BU; new ones can be assigned
   on creation.

---

## 3. API keys

**Why:** Long-lived credentials for machine-to-machine integrations
(your CI pipeline, a custom integration, an analytics ETL).

**Steps to issue a key:**
1. **API keys** → **Issue key**.
2. Pick the persona to associate (typically a `service` persona).
3. Pick scopes — minimum-privilege is the rule. A key that only reads
   metrics should not have `tenant.admin` scope.
4. (Optional) set an expiry. Anything without an expiry will be flagged in
   compliance reviews.
5. Copy the key **once** — it's shown only at creation. ProjexCloud stores
   only a hash.

**Steps to rotate:**
1. Click the key row → **Rotate**.
2. A new secret is generated; the old one stays valid for 10 minutes (grace
   window) so you can swap config without downtime.

**Steps to revoke:**
1. Click the key → **Revoke**. Instant; no grace window.

---

## 4. Webhooks

**Why:** ProjexCloud pushes events (invoice finalized, persona created, ticket
status changed, etc.) to URLs you control. This page is where you wire those up.

**Steps to add a webhook:**
1. **Webhooks** → **+ Add endpoint**.
2. Paste the URL (must be HTTPS in production).
3. Pick event types — start narrow; you can always add more.
4. Save. ProjexCloud issues a signing secret; copy and store it in your
   handler's config. Every delivery includes an HMAC signature header.

**DLQ replay:**
If your endpoint goes down, failed deliveries land in your DLQ.
- **Webhooks → DLQ** → see failures.
- Click **Replay** to re-send. Use this *after* your handler is fixed.
- Old deliveries past 7 days are pruned automatically.

**Common pitfalls:**
- Returning a 2xx with an empty body is fine; we only look at status codes.
- Returning 200 from an async queue (before processing) is the right pattern.
  Don't make ProjexCloud wait for your downstream system.
- Rotate the signing secret regularly via **Rotate secret** — old one stays
  valid for 60 s.

---

## 5. Approvals

**Why:** Some actions in your tenant (export-all, BYOK rotation, deleting an
audit-relevant record) need a second pair of eyes. The Approvals page is your
queue + history.

**Sections:**
- **My pending decisions** — requests waiting for *you* personally to decide.
- **My open requests** — requests *you* raised that are still pending.
- **Routes** — the rules that determine who needs to approve what. Configure
  these once, then they apply automatically.

**Steps to decide a request:**
1. **Approvals** → click a request in "My pending decisions".
2. Read the action description and any attached evidence.
3. Approve or Reject + comment (comments are part of the audit chain).

**Steps to add an approval route:**
1. **Approvals → Routes** → **+ Add route**.
2. Specify the trigger (e.g., "any data export over 1 GB").
3. Specify approvers (by persona or role).
4. Set the SLA (default 24 h). Breached SLAs page your designated
   escalation persona.

---

## 6. Connectors

**Why:** Wire your tenant into Slack, Salesforce, Microsoft 365, Google
Workspace, Jira, Linear, Zendesk, Zoom, HubSpot, GitHub, Snowflake — whichever
ones are part of your plan.

**Steps to connect Slack (example):**
1. **Connectors** → **Slack** → **Connect**.
2. You're redirected to Slack's OAuth flow; pick the workspace and approve
   scopes.
3. On return, pick which Slack channels ProjexCloud may post to.
4. (Optional) map ProjexCloud events to channels (e.g., "post invoice-finalized
   to #finance").

**Disconnecting:** every connector has a **Disconnect** button. This revokes
the stored OAuth token and stops new events; historical data already ingested
stays.

**Health checks:** the connector row shows a status dot. Red means the token
expired or was revoked upstream — click **Reconnect**.

---

## 7. Consent

**Why:** GDPR/CCPA-style receipts. Every data-processing purpose for which
ProjexCloud holds personal data on a subject must have an explicit, dated
consent receipt; subjects (your end users) can revoke at any time.

**Sections:**
- **Receipts** — every consent record, filterable by subject + purpose.
- **Purposes** — the list of processing purposes your tenant uses. New purposes
  must be defined here before they can be referenced in a receipt.

**Common workflows:**
- *DSAR (data subject access request):* filter Receipts by subject email →
  export. Pair with the data-rights SDK's "subject export" job for the actual
  data payload.
- *Right to be forgotten:* mark the subject's receipts as revoked; the
  data-rights SDK fans out deletion to every store keyed by that subject.

---

## 8. AI — MCP servers

**Why:** ProjexCloud's AI gateway routes LLM calls through approved
providers. This page is where you register your tenant's MCP (Model Context
Protocol) servers — typically your own data sources you want the AI to be
able to read.

**Steps to register an MCP server:**
1. **AI** → **+ Add MCP server**.
2. Paste the server URL + auth credentials (stored encrypted via `sdk-vault`).
3. Select which agent personas may use it. Minimum-privilege rule applies:
   most agents should not have access to most servers.
4. Save. The AI gateway runs a probe to verify the server responds within SLA;
   a green status means agents can now bind to it.

**Common pitfalls:**
- Hosting the MCP server on `localhost` from your laptop won't work — agents
  run in ProjexCloud's network and need a reachable URL.
- Giving every agent access to every server defeats AC-2 (cross-tenant
  leakage) tests — keep scopes tight.

---

## 9. BYOK — Bring Your Own Key

**Why:** Customers with strict crypto controls insist on holding their own KMS
keys; ProjexCloud encrypts your tenant's data with envelope keys wrapped by
*your* KMS, so we can never read it without you.

**Steps to enable BYOK:**
1. **BYOK** → pick provider (AWS KMS, GCP KMS, Azure Key Vault).
2. Paste the KMS key ARN/URI.
3. Grant ProjexCloud's service principal the `Encrypt`+`Decrypt`+
   `GenerateDataKey` permissions on that key (provider-specific console
   steps shown inline).
4. Click **Verify**. The gateway runs a test encrypt/decrypt; green means
   you're live.

**Rotation:** click **Rotate key**. New writes use the new key; old data is
re-encrypted lazily.

**Revoke:** removing ProjexCloud's KMS grant from your side breaks
ProjexCloud's ability to read your data. Don't do this casually — coordinate
with platform support, otherwise your tenant goes dark.

---

## Day-1 onboarding checklist

When your tenant is freshly provisioned, do these in order:

1. **Members** — invite your first 1–2 admins, then your team.
2. **API keys** — issue one service key for your CI; rotate the one you
   were given at provisioning.
3. **Webhooks** — register endpoints so your downstream systems get events.
4. **Approvals** — set up at least one approval route for destructive actions.
5. **Connectors** — wire Slack/SF/M365 so events flow into the tools your
   team already uses.
6. **Consent** — declare your processing purposes; required before you start
   collecting personal data.
7. **BYOK** (optional but recommended for regulated industries).
8. **Billing** — bookmark this; check it weekly during the first month so
   surprises don't compound.

---

## Troubleshooting

**Billing page shows no data.**
The gateway can't reach your tenant's pool, or your JWT's tenant_id doesn't
match what the URL expects. Check the URL has your tenant_id. If you've been
issued the wrong tenant_id, contact your ProjexCloud rep.

**Webhook deliveries all failing.**
- Confirm your endpoint is reachable from the public internet.
- Confirm you're returning a 2xx within 10 s.
- Check the signing-secret rotation didn't leave your handler with a stale
  secret.

**API key issued but my integration says 401.**
- The key is shown **once** at creation; if you missed it, revoke + reissue.
- Scopes too narrow — check what your integration actually calls and grant
  matching scopes.

**Connector status red.**
Token expired or was revoked upstream. Click **Reconnect**.

**Need to escalate to platform staff.**
Your tenant_id + the relevant timestamp range is the most useful first message.
Don't paste API keys or webhook secrets in the support thread.
