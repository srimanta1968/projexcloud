# Destination resolution — accepted, generalised

Reply to `LeadFlow/docs/integration/destination-resolution-requirements.md`.

**Your answer is better than the design I was heading toward, and I am taking it.**
Resolve-at-send, no address crosses the boundary, no resolver that returns
addresses. The zero-new-erasure-surface argument is the one that settles it.

This document does one more thing you did not ask for: it makes the contract
**app-agnostic**. LeadFlow's answer works because LeadFlow has
`channelDecision.compose()`. The next consumer will not. If I build the contract
around a `channel_decision_id`, I encode one app's architecture into a platform
SDK and the second consumer either fakes a decision id or is locked out. §3 is
that generalisation; §2 is what you get either way.

---

## 1 · Role provisioning — your fix is right, and two of your three suggestions land

Good catch on `PROJEXCLOUD_APP_ID`, and thank you for the correction: I said only
an operator-token call could unblock it, which was wrong for your case because
`signup-tenant` had already made the `tenant.app` row. The tell you name — consent
purposes keyed on the slug and unaffected — is the one I should have caught too,
since I had both facts in front of me.

Taking your preference order:

**(1) Make `POST /api/applications` create the `tenant.app` row — declining, with
a reason.** The two rows are not the same object. `tenant.app` is an application
in the *product* sense (one per tenant in the current schema, referenced by
`tenant.tenant.app_id` and carried in the JWT); `api_keys.application` is a
*credential holder* with its own `environment` (live/test), and minting a second
one for the same product app is normal and correct — one key per consumer is the
documented advice. Auto-creating a `tenant.app` per credential holder would
manufacture product apps as a side effect of key management and make
`tenant.tenant.app_id` ambiguous. That is the fault line widening, not closing.

**(2) and (3) — both, and they are the real fix.** `role_template` will reject an
id that resolves in `api_keys.application` with a message naming the other space,
instead of a raw FK violation surfaced as `InternalError`; and `POST
/api/applications` will return the owning `tenant.app` slug alongside its UUID so
the two are distinguishable at the point of confusion. Your case was not "a
missing row", it was "an endpoint handed back an id from the other space with no
indication it was not interchangeable" — (3) removes the trap, (2) catches whoever
still falls in.

The genuine second-application case stays open and is tracked separately; it needs
a decision on whether a tenant may own several product apps (the
`tenant.tenant.app_id` vs `app_pool_index` contradiction), which is a schema
question, not a patch.

---

## 2 · What gets built

**`POST /api/notifications/send-to-audience`** — send by reference. It never
accepts and never returns an address.

```jsonc
{
  "tenant_id": "…",
  "audience":  { "kind": "role", "role_template_id": "…" },
  "channels":  ["in_app", "email"],
  "template_code": "sla_breached",
  "variables": { "…": "…" },
  "authorization": { "mode": "exempt", "basis": "internal_recipient",
                     "justification": "colleague notification — SLA breach" }
}
```

Response is per-recipient and **address-free**:

```jsonc
{ "data": { "results": [
    { "persona_id": "…", "channel": "in_app", "status": "sent" },
    { "persona_id": "…", "channel": "email",  "status": "deferred",   "reason": "quiet hours" },
    { "persona_id": "…", "channel": "email",  "status": "suppressed", "reason": "recipient is suppressed" },
    { "persona_id": "…", "channel": "email",  "status": "no_destination" }
  ], "decision_id": "…" } }
```

Three properties I am committing to, because they are what make your erasure
argument hold for *every* consumer rather than only for a careful one:

- **`status: "no_destination"` is a first-class outcome, not an error.** A persona
  with no usable alias must be reported as unaddressable rather than silently
  dropped or 500'd. Silent drop is how "we notified the team" becomes false.
- **The notification ledger stores `persona_id` + status + decision, never the
  destination.** The address is read, used, and discarded within the request. No
  new erasure surface on our side either.
- **Address resolution is an internal function with no route.** `identity.alias`
  decryption happens inside the send path and is not reachable through any
  endpoint. Per your §3, it is not exposed at all — not gated behind a permission,
  simply absent from the API surface.

`listRoleHolders()` ships exactly as built, unchanged, per your §3. It is already
committed to this branch.

---

## 3 · The generalisation — how a different app fits

Two things in your requirements are LeadFlow-shaped, and both need a seam rather
than a hardcoding.

### 3.1 Authorization: an envelope with three modes

You have your own gate and want us to trust it. An app without one needs us to
*be* the gate. Both are legitimate, so `authorization` is a tagged union and the
mode is recorded on the decision row:

| mode | who decided | what the platform does |
|---|---|---|
| `platform` | us | Runs sdk-consent against `purpose`, plus suppression, quiet hours, frequency cap. For an app with no decision engine of its own. |
| `delegated` | the app | Records `decision_ref` + `expires_at`. Re-checks only the facts the platform owns, and only in the restrictive direction. **Refuses once `expires_at` has passed.** |
| `exempt` | the app, explicitly | Records `basis` + `justification` as a decision. Never a skip. |

`purpose` in `platform` mode is **not** a fixed list. Purposes are already
tenant-registered through `POST /api/consents/purposes` and validated per tenant —
your six are yours, another tenant's are theirs, and the platform never needs to
know either set. So your "purpose must be required, never defaulted" holds
generically: in `platform` mode it is required and must resolve to a purpose that
tenant registered. Unregistered purpose → 400, not a permissive default.

The `delegated` re-check is your own insight generalised, and it is the part I
would most like on the record: **an unexpired delegated decision is inherited, not
trusted.** Between your `compose()` and our dispatch, a consent can be revoked or
an address suppressed. The platform therefore re-evaluates suppression and channel
pause itself and may only ever *narrow* your allow — it can turn your `send` into
`suppressed`, never a `deny` into a send. That way a delegated decision cannot go
stale in the permissive direction no matter how long an app holds it.

Also taken from your §2, generically: **a resolved destination is never
eligibility.** The resolver returning a phone number says nothing about whether
SMS may be used; only the authorization envelope does. That is enforced by
ordering — authorization runs before resolution, and resolution is not reached for
a channel the decision denied.

### 3.2 Audience: four kinds, one extension point

```
{ kind: "persona",      persona_ids: [...] }              // direct
{ kind: "role",         role_template_id, include_primary } // via listRoleHolders — your case
{ kind: "address",      channel, destination }            // today's /dispatch, unchanged
{ kind: "external_ref", scheme, value }                   // extension point
```

`external_ref` is what makes a different app fit without a platform change. Not
every consumer's recipients live in `identity.alias`: a support tool addresses
Slack user ids, an ops tool addresses a PagerDuty schedule, a healthcare app
addresses a practitioner directory. Those resolve through a **per-tenant resolver
registered as a URL**, called by the platform at send time, returning a
destination that is used and discarded under the same no-persist rule. The app
owns its directory; the platform owns the send. Nothing about that path is
LeadFlow-specific, and LeadFlow never has to use it.

Channel note: `in_app` needs no resolution at all — the `persona_id` *is* the
address. Worth stating because it means an app can adopt this with zero
destination surface anywhere.

### 3.3 Bulk is a different question, and a different permission

Agreed that "who pulled fifty thousand addresses" is not "who sent one email".
Since nothing here returns addresses, the bulk risk is *fan-out*, not disclosure —
so the ceiling is on recipients per call, configurable per tenant, and exceeding
it is a 400 naming the ceiling rather than a truncated send. A silently truncated
audience is the same class of bug as a silent drop.

On permissions: I will not gate on "is an admin" — your point about Sales Manager
holding `call.review` but not `message.send_approved`, and `privacy` holding
`consent.purpose_manage` as a separate account, is well made. But
`message.send_approved` is *your* role vocabulary and cannot be a platform
constant. The platform gates on its own scope (`notification.*`, derived from the
path as today) and carries an `on_behalf_of` actor so the audit names the human,
while the app enforces its own finer permission before calling. Your role model
stays yours; ours does not have to learn it.

---

## 4 · Open, and needing your view

**Which channels must resolve at send for you in practice?** Your examples are
`in_app` and `email`. If `in_app` alone covers the internal-colleague case, the
first cut needs no alias read at all and ships sooner — email resolution can
follow. Tell me if `email` is load-bearing for internal alerts on day one.

**Is `no_destination` actionable for you, or just observable?** If LeadFlow wants
to fall back (email fails → in_app), I should return the per-channel results in a
single call as above rather than have you re-drive. The shape supports it; I want
to know whether you will use it before I promise the semantics.

---

## Status

- `listRoleHolders()` + `GET /api/role-templates/:role_template_id/holders` —
  built, typechecked, SQL verified against Postgres, api_definition written.
  Unchanged per your §3.
- Everything in §2 and §3 — designed, not built. Nothing here is deployed.
- §1 items (2) and (3) — not built.
