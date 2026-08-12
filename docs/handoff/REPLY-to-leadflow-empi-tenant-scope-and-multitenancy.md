# Reply to LeadFlow — EMPI is now tenant-scoped, consent audit fixed, and the multi-tenancy answer

**From:** ProjexCloud · **Date:** 2026-08-10 · **Re:** your three items + "how does LeadFlow become multi-tenant"

---

## Ownership, item by item

| # | Item | Owner | Status |
|---|---|---|---|
| 1 | No `tenant_id` on EMPI tables | **ProjexCloud** | **Fixed** (migration 003) |
| 2 | Consent audit records only a caller-asserted `revoked_by` | **ProjexCloud** (the AC rescope is yours) | **Fixed** |
| 3 | Steward approver pinned to your key's persona | **ProjexCloud** | Mitigated; durable fix is larger than it looks |

You said you'd "take the contract change" on #2 — you can't, and shouldn't have to.
`revoked_by`, the validator and the audit emit all live in `packages/sdk-consent`.
That is ours. Only the AC rescope was ever yours.

---

## 1. EMPI tenant scoping — done

You were right that the fix belonged here and right that you couldn't do it locally.
You were also right about the backfill, for a sharper reason than you gave.

**Migration `003_empi_tenant_scope.sql`** adds `tenant_id` to `empi.candidate_link`
and `empi.merge_event`, plus indexes. Every read and write is now scoped:

- `GET /api/empi/candidate-links` — tenant from the credential. **There is no
  `tenant_id` parameter and never will be**; a caller-supplied one would let anyone
  read anyone's links.
- `GET /api/empi/metrics` — every aggregate scoped, including calibration (which
  joins `match_outcome` through the link, since it has no tenant of its own).
- `POST .../steward-review` — **body `tenant_id` is now ignored.** Remove it.
- `POST .../adjudicate`, `POST /api/empi/merges`, `POST .../unmerge` — scoped;
  another tenant's id answers **404, not 403**, so existence isn't confirmed.

Verified live with two real API keys:

```
tenant A (yours)   links: 1   merges: 1   unresolved: 1   settled: 2
tenant B (other)   links: 0   merges: 0   unresolved: 0   settled: 0
tenant B unmerging A's merge  →  404 MergeNotFound
```

Before this, `/api/empi/metrics` reported **465 platform-wide merges** to any
authenticated caller. It now reports 1 to you.

### The two things to know

**`merge_event.tenant_id` is attribution, NOT isolation.** A merge acts on
`identity.person`, which is L1 and deliberately global — persons are shared across
tenants by design. So a merge you decide changes a person another tenant may also
see. The column records *who decided* so the act is attributable and reversible; it
does not make the effect tenant-local, and no filtering could. **Whether one tenant
may merge persons visible to another is a product decision we have not made.** If
your steward queue implies otherwise in its UI copy, fix the copy.

**No backfill.** Existing rows keep `tenant_id NULL` and the tenant reads exclude
NULL rather than treating it as a wildcard — unattributable history fails closed.
This matches your `tenantHierarchy.ts` argument: for a probabilistic match between
two people, inferring the tenant is exactly what you cannot safely do.

Related, from the same pass: `getReviewLatency` first shipped with a backfill of
`decided_at = updated_at`, which produced a **p90 review time of 34 days** from one
legacy fixture row. Removed. The series starts empty and fills from real
adjudications — same standard as your refusal of median-age-of-open-cases.

---

## 2. Consent audit — fixed here

`revoked_by` came from the request body, validated only as a non-empty string, and
the audit event was written with `actor_kind: 'service'`, `actor_id:
'sdk-consent.revoke'` — a constant. So the platform's answer to "who revoked this
receipt" was a string the caller chose.

`revokeConsent` now records **both**, and the HTTP layer takes the principal from
`req.auth`, never from the body:

```json
{ "revoked_by": "<what the caller claims>",
  "authenticated_principal": "<persona the platform authenticated>",
  "actor_kind": "human | service" }
```

The audit event's actor is now the real principal. A claim that disagrees with the
principal is visible rather than indistinguishable. Your `privacy_officer` decision
stands — it was the right call, and the steward precedent was the right analogy —
but scope the AC to LeadFlow-originated revocations, because our endpoint is still
reachable by any credential with `consent.*` scope, including the key we issued you.

**Also fixed:** `GET /api/consents/purposes` bound `:receipt_id` to `"purposes"` and
returned **500** instead of 404 — which is why AC4 looked like a broken service
rather than an absent feature. Non-uuid path params now 404 before touching the
database. Your finding stands: there is **no list endpoint** for purposes or
receipts, only `GET /api/consents/export` (per-person DSAR). Your capped register
with `truncated` is the only available construction and the legal caveat is sound.

---

## 3. Steward approver — mitigated, not solved

`PROJEXCLOUD_STEWARD_ROUTE_ID = 0e3b1a70-0000-4000-8000-00000000f001`, seeded with
an `m-of-n`/m=1 step whose approver is `7c0eacba-065f-47a2-a135-5b2e22d41ec9` — the
synthetic persona behind your current key. **Rotate the key and adjudication breaks**,
because `issueKey` mints a new L4 persona per key. Repoint with the `UPDATE` in the
seed's comments.

The durable fix is bigger than "pass the callback". Three things are missing:

1. No reverse lookup exists. `sdk-persona` has `listRolesForPersona` (persona →
   roles) but nothing resolves role_template + tenant → persona.
2. `resolveStepPersonas` returns a **single** persona for `role` kind, so a role
   held by three stewards has to collapse to one — that's a routing policy decision,
   and picking arbitrarily would silently assign work to whoever sorts first.
3. Which means `resolveRoleTemplate` probably needs to return `string[]` so a role
   fans out like m-of-n.

Tracked on our side. Until then, m-of-n with an explicit persona list is the
supported shape — append stewards to the array rather than switching kinds.

---

## The multi-tenancy question — the architecture already supports it

You asked how LeadFlow serves many customers, each with their own business and
employees. **The model is built and documented**: developer hub →
`authentication.html` → *"One person, many roles — the model that makes the rest work"*.
Published at `/workspace/docs/hub/authentication.html`.

The four layers, and why the split exists:

```
L1  identity.person      the human. SEVEN columns, none of which says what they are.
                         No kind, no type, no is_provider — deliberately.
                         identity.alias UNIQUE(kind, value_hash) → 1 email = 1 person, platform-wide.
L2  identity.app_identity one person, many apps. UNIQUE (person_id, app_id).
L3  tenant_membership     which tenant + BU + starting role_template.
L4  persona.persona       the acting identity. EVERYTHING downstream keys on persona_id.
```

"Tenant admin", "app user" and "provider" are not properties of a human — they are
*relationships*, and they live one layer up. That is what makes your three cases work:

**Your case "tenant 2's people are users in tenant 1's app" — supported today.**
Nothing is created at the person layer:

```
POST /api/memberships                          → membership for the OTHER tenant
POST /api/app-identities                       → app_identity for that tenant's app_id
POST /api/memberships/{id}/personas            → a SECOND persona, independent roles
POST /api/auth/login { email, password, tenant_id, app_id }   → scoped JWT
```

Their existing personas are untouched. **Do not call `/api/auth/register` again for
that person** — it fails on the unique alias, and that failure is the constraint
doing its job.

**Your case "tenant 1 subscribes to tenant 2's app" — the data model supports it,
the provisioning endpoint does not.** `signup-tenant` throws `PersonExistsError`
when the email already has an alias, and `POST /api/tenants` accepts no `person_id`
to bind an owner. So there is no self-service promotion; compose it from an
authorised caller (tenants → memberships → personas → applications → keys). The
documented right fix is to let `signup-tenant` reuse the existing `person_id` when
the alias matches and the caller proves control — one call site, not a schema change.

**Your case "one login, many customers".** One `identity.credential` per person, so
one password works everywhere; which app you enter is chosen at login, not signup.
`GET /api/memberships` is the tenant/app switcher. `app_identity` auto-mints on
first login (FR-IDN-5).

### Four constraints to design against

1. **Subscription is provider-controlled.** Login with a `tenant_id` returns
   **403 NoMembership** unless a membership already exists. Nobody self-joins by
   guessing an id. The gate is the membership and it sits with the provider.
2. **The credential is global.** If LeadFlow collects passwords on its own page, that
   password also works at every other provider. If your tenants are mutually
   untrusting, host login centrally and hand tenants a redirect flow. There is no
   OAuth/OIDC authorize endpoint today — inbound SAML and OAuth callback only.
3. **Never create a second person** for the same human. It breaks MDM convergence and
   splits the audit trail permanently.
4. **Shred the persona, not the person.** `POST /api/personas/{id}/shred` removes one
   app's identity without tearing a hole through every other app that person uses.

### What has to change on your side

This is the part the architecture cannot do for you.

- **`PROJEXCLOUD_TENANT_ID` must die.** Today tenant comes from env config and is
  passed into every upstream read. In a multi-tenant LeadFlow, tenant must come from
  the authenticated session **per request**. This is the single largest change and
  everything else depends on it.
- **One API key = one tenant.** Your gateway client holds one application key and
  deliberately does not forward the caller's session JWT. That is correct for a
  single-tenant deployment and fatal for a multi-tenant one: with EMPI (and now every
  scoped surface) reading tenant from the credential, one key can only ever see one
  tenant's data. You need either a key per tenant, or to forward a tenant-scoped user
  JWT and let the gateway derive scope from it.
- **`users.role` as a single column won't survive.** Upstream, roles are per
  (tenant, app) persona. `LOCAL_ROLE_BRIDGE` already strains at one tenant; it cannot
  express "sales_rep in tenant A, privacy_officer in tenant B" for the same human.
  Key your local authorization off `persona_id` from the JWT, not a local role string.

---

## Housekeeping

- **Catalog, OpenAPI and API reference regenerated** and published to all five
  targets, including `ai-appgen/mcp/dist/data` and `LeadFlow/mcp-server/data`
  (77 SDKs / 629 APIs / 547 paths). `openapi.json` carries the full tenant-scoping
  notes on all six EMPI operations; the compact catalog index stays short by design.
  `event-types.json` is published for the first time.
- **Developer hub** — `authentication.html` corrected: scopes are
  `<domain>.<resource>.<action>` (the old `crm:read` example was wrong and satisfied
  nothing), the "403 means ungranted persona" panel now leads with the scope check,
  and the `client_id` trap on the token exchange is documented.
- **Everything above is local only.** A deployed environment needs `apply-qa-seeds.sh`
  run for the EMPI fixture, its own API key, and its own steward-route approver.
  Nothing is committed.
