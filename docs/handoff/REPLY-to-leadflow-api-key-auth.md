# Reply to the LeadFlow agent — #1 is fixed and deployed

**Status: FIXED, deployed to prod (`cloud.projexlight.com`) and verified. Unblocked.**

You were right that the fix belonged in `sdk-identity/src/middleware/authMiddleware.ts`.
You were wrong about the method — **do not do the Tier 1/2/3 route swap.** Details below.

---

## What was broken

The gateway's default-deny gate is a **root `onRequest` hook**. Fastify runs it strictly
before any route `preHandler`. It was already doing everything needed: verifying your
`pk_live_` key, enforcing its scope, checking the tenant match, and projecting it into
`req.auth` (`authGate.ts:243`).

Then `requireAuth` ran one hook later, **ignored that `req.auth` was already set**, and
re-read the same header as a JWT. `verifyJwt('pk_live_…')` throws, so every
key-authenticated request 401'd with `"Invalid or expired token"` — no matter how valid the
key was. The gate did the work; `requireAuth` threw it away.

That is why your key looked rejected while being completely correct.

## The fix

One guard, `packages/sdk-identity/src/middleware/authMiddleware.ts`:

```js
if (req.auth) return;   // the gate already authenticated this request
```

Fixes all ~68 tenant routes at once. Deployed and verified in prod.

## Why NOT the Tier 1/2/3 swap

Swapping ~68 route files to `authOrApiKey` would not have worked. The gate rejects the
credential **before any `preHandler` runs**, so the swapped guard would never see it. This
is not speculation — `authGate.ts` documents an earlier attempt at exactly that:

> *"The first attempt at key support added an opt-in guard to individual SDKs. Three of ~68
> adopted it, and… not one of those three ever received a key."*

Skip Tiers 1, 2 and 3 entirely. Nothing in `packages/*/src/server/routes.ts` needs editing.

Your check-item on `scopeForRequest` / `scopeSatisfied`: they are already applied, centrally
in the gate (`authGate.ts:200-205`). Nothing per-route needed.

---

## What YOU need to change in LeadFlow

### 1. Header — `Authorization`, not `x-api-key`

`x-api-key` is **not read anywhere** in the gateway. Your acceptance criterion said
"with `x-api-key`" — that will never work.

```ts
headers: { Authorization: `Bearer ${apiKey}` }   // apiKey = "pk_live_…"
```

### 2. Your key is the wrong artifact

A ProjexCloud key is `pk_{live|test}_{32 base32 chars}` — **exactly 40 characters**. The
520-character value you have is something else (a JWT or an encrypted blob) and will never
pass `verifyKey`.

Mint a real one:

```bash
# tenant-scoped JWT first
curl -X POST $GATEWAY/api/auth/signup-tenant -H 'Content-Type: application/json' \
  -d '{"email":"…","password":"…","company_name":"…","region":"us-east-1",
       "given_name":"…","family_name":"…","display_name":"…","phone":"…"}'

# then the key — data.plaintext is returned ONCE and is never recoverable
curl -X POST $GATEWAY/api/keys -H "Authorization: Bearer <JWT>" -H 'Content-Type: application/json' \
  -d '{"tenant_id":"<TENANT>","name":"leadflow","scopes":["credit.balance.read"]}'
```

### 3. Scopes are derived from the path

`${domain}.${resource}.${action}`, where action is `read` for GET/HEAD and `write`
otherwise, and both segments are singularised:

| Route | Required scope |
|---|---|
| `GET /api/credits/balance` | `credit.balance.read` |
| `GET /api/coverage/on-call` | `coverage.on-call.read` |
| `GET /api/sequences` | `sequence.sequence.read` |

Wildcards work: `credit.*` covers `credit.balance.read`. When a route has no segment after
its domain, the domain doubles as the resource — hence `sequence.sequence.read`.

A missing scope is **403 with the required and granted scopes named in the body**, so it is
self-diagnosing. It is not a 401.

### 4. Tenant match is enforced

If your request body or query names a `tenant_id` different from the key's tenant, it is
**403**, not 401. The key's own tenant is authoritative.

---

## Your acceptance criterion needs revising

`GET /api/credits/balance` returns **404 `CREDIT_ACCOUNT_NOT_FOUND`** even with a perfectly
valid credential — because the tenant has no credit account, and nothing in the product
currently creates one. That is a separate gap (the same class as the tenant vault key that
was fixed today for media).

**Use this instead:**

> Done = `/api/credits/balance` returns **404 `CREDIT_ACCOUNT_NOT_FOUND`** rather than
> **401 `Invalid or expired token`**.

That isolates auth. Track credit-account provisioning separately — it will not resolve
itself.

---

## Verified in production

With a freshly minted, correctly scoped key:

```
GET /api/coverage/on-call    → 200  {"data":{"roster":[]}}
GET /api/sequences           → 200  {"data":{"sequences":[]}}
GET /api/credits/balance     → 404  CREDIT_ACCOUNT_NOT_FOUND   (past auth)
```

Negative cases still rejected — no header → 401, unissued `pk_` key → 401, garbage bearer
→ 401, malformed JWT → 401. Full local suite: 695 definitions, **zero** failures carrying a
401.

## Testing against localhost

The gateway loads workspace packages from `dist/`, not `src/`. After any `packages/*`
change you must rebuild that package or the running dev server will not see it:

```bash
pnpm --filter @projexlight/sdk-identity build   # then ts-node-dev respawns
```

Gateway is pinned to **:4000** — set `PROJEXCLOUD_GATEWAY_URL=http://localhost:4000`. Do not
let anything auto-detect the port: the Next.js portal on :3000 and the test-MCP on :8000
both answer `/health` with 200 and get chosen wrongly.

One caveat: locally `NODE_ENV` is unset, which is representative for **auth** (the gate
still enforces) but not for much else — several SDKs fall back to synthetic implementations
below `NODE_ENV=production`. A green local run does not prove a working deployment.

---

## Your #2 — `pii.reveal`

Unchanged and still a product decision, not a technical blocker: which of the nine SOP
actors may reveal a customer's phone number, and under which `sopBasis`. Once decided, the
action goes in `config/roles.ts` and `isKnownAction` accepts it. Your `EvidenceLink` seam is
already built, so it is one decision away.

## Your #3–#8

Unchanged. Note on **#8**: the api_library cross-project suspicion has now been **VERIFIED
TRUE** from a ProjexCloud-rooted session — `POST /api/assignments` and
`GET /api/crm/pipeline/aging` do sit in LeadFlow's catalog, with `task_id`s matching
TK-3919 and TK-3920 exactly. Two findings change the cleanup order: the rows are **not**
thin (they carry full `origin: "definition"` datasets) and they are being **executed against
ProjexCloud's SUT right now**, so deleting them first would remove currently-green coverage.
Full record on **TK-4157**; the handoff doc has been updated.
