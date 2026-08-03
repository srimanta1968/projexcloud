# Calling ProjexCloud from Another Project (API Keys)

How a separate application — a ProjexLight-generated vertical, or anything you
write yourself — authenticates against the gateway's tenant-callable SDK routes.

The Developer Hub carries the same material in a browsable form:
[`docs/v3.1/developer-hub/api-keys-and-project-setup.html`](../v3.1/developer-hub/api-keys-and-project-setup.html).
This page is the terminal-friendly version, plus the operator detail that hub
readers do not need.

## 1. Which credential

| Caller | Credential | Obtained from |
|--------|-----------|---------------|
| **Your backend, server-to-server** | API key (`pk_live_…` / `pk_test_…`) | `POST /api/api-keys` |
| A signed-in human in a portal or your UI | Six-layer JWT | `POST /api/auth/login` |

Both are accepted on the SDK routes listed in §5, and both normalise to the same
`req.auth` claim set, so handlers never branch on which one arrived.

> **Do not put a person's email and password in a service's environment.** It
> inherits every privilege that human holds, makes their audit trail
> indistinguishable from the service's, breaks as soon as MFA is enabled
> (`/api/mfa/challenge` exists), and dies at the next password rotation. This was
> the only option before API-key auth was wired up; it no longer is.

## 2. Issue a key

```bash
GATEWAY=http://localhost:3000          # or https://cloud.projexlight.com

# a) a JWT, purely to authorise the issuance
JWT=$(curl -sX POST "$GATEWAY/api/auth/login" \
  -H 'Content-Type: application/json' \
  -d '{"email":"you@example.com","password":"…"}' | jq -r '.data.token')

# b) the tenant the key will belong to
curl -s "$GATEWAY/api/tenants" -H "Authorization: Bearer $JWT" | jq '.data'

# c) the key itself
curl -sX POST "$GATEWAY/api/api-keys" \
  -H "Authorization: Bearer $JWT" -H 'Content-Type: application/json' \
  -d '{
    "tenant_id": "<tenant-uuid>",
    "scopes": ["sla.clock.write","sla.clock.read","assignment.assign-by-task.write"],
    "rate_limit_rpm": 600,
    "expires_at": "2027-01-01T00:00:00Z"
  }' | jq '.data'
```

`201` returns `{ key, plaintext }`.

> **`plaintext` is shown exactly once and is not recoverable.** Only a
> PBKDF2-SHA256 (310,000-iteration) hash and a display prefix are stored. Copy it
> straight into your secret store. If it is lost, rotate — there is no read path.

No tenant yet? `POST /api/auth/signup-tenant` creates one. A dev environment
bootstrapped with `dev-setup --seed` already has a development tenant from
`scripts/setup/seed-dev-data.mjs`.

Issue **one key per integration** so revoking one cannot take down another, and
set `expires_at` — a never-expiring key is a standing liability.

## 3. Scopes

Scopes follow the platform convention `<domain>.<resource>.<action>` (as in
`crm.contact.read`, `rebac.relationship.write`). For the SDKs in §5 the required
scope is **derived from the route**, so no lookup table is needed:

| Part | Rule |
|------|------|
| `domain` | The SDK namespace — `sla`, `assignment`, `notification` |
| `resource` | Path segment after the domain, singularised (`clocks`→`clock`, `policies`→`policy`); path params skipped |
| `action` | `read` for GET/HEAD, `write` otherwise |

```
POST /api/sla/clocks                      → sla.clock.write
GET  /api/sla/policies                    → sla.policy.read
POST /api/sla/policies/:policy_id/rungs   → sla.policy.write
POST /api/assignment/assign-by-task       → assignment.assign-by-task.write
POST /api/notifications/send              → notification.send.write
```

A `403` names the missing scope **and** lists what the key holds, so calling the
endpoint is the quickest way to discover the scope set you need.

Scopes apply to keys only. A JWT caller's authority comes from their persona and
ReBAC grants, so opting a route into key auth changes nothing for human traffic.

## 4. Configure the calling project

```dotenv
# in YOUR app's .env — never commit the key
PROJEXCLOUD_GATEWAY_URL=https://cloud.projexlight.com
PROJEXCLOUD_API_KEY=pk_live_…
PROJEXCLOUD_TENANT_ID=<tenant-uuid>
PROJEXCLOUD_TIMEOUT_MS=8000
```

Request contract:

```http
POST {PROJEXCLOUD_GATEWAY_URL}/api/sla/clocks
Authorization:    Bearer {PROJEXCLOUD_API_KEY}
Content-Type:     application/json
Idempotency-Key:  <stable per logical operation>
x-correlation-id: <uuid>

{ "tenant_id": "…", "policy_id": "…", "subject_ref": "lead:…" }
```

Three mistakes that account for most lost time:

| Wrong | Right |
|-------|-------|
| `x-api-key: <key>` | The key goes in `Authorization: Bearer` |
| `x-tenant-id: <id>` | `tenant_id` goes in the body or query string |
| `/{sdk}/v1/…` URLs | There is **no** per-SDK path prefix — each SDK registers real `/api/<domain>/…` routes on the one gateway. Confirm paths in [`docs/api_docs/`](../api_docs/) |

Because handlers read `tenant_id` from the payload, the guard cross-checks it
against the key's own tenant and answers `403` on a mismatch — so a leaked key
cannot be aimed at another tenant, and the `tenant_id` you send must be the one
the key was issued for.

### Local and hosted from one codebase

Read the base URL from the environment, keep a separate key per target, and let a
run-time value override the committed default (dotenv does not overwrite an
existing `process.env` entry, so a shell value wins):

```bash
PROJEXCLOUD_GATEWAY_URL=http://localhost:3000 npm run dev          # local gateway
PROJEXCLOUD_GATEWAY_URL=https://cloud.projexlight.com npm run dev  # hosted
```

Use `pk_test_` keys locally and `pk_live_` in production so a leaked dev key can
never reach live data.

Treat "no key configured" as a **different state** from "key rejected". A client
that degrades deliberately — falling back and recording which path produced the
result — is far easier to operate than one that 502s. A wall-clock SLA verdict and
a business-calendar one are not the same measurement and must not be conflated.

## 5. Which routes accept a key

Wired via `requireAuthOrApiKeyForDomain()` from `@projexlight/sdk-api-keys`:

| SDK | Domain | Routes |
|-----|--------|--------|
| `sdk-sla` | `sla` | 30 |
| `sdk-notification` | `notification` | 14 |
| `sdk-assignment` | `assignment` | 2 |

Everything else remains JWT-only by design. `requireAuth` itself was deliberately
**not** extended: doing so needs zero route edits but would make every route on
the platform accept keys, including admin and break-glass surfaces that must stay
human-only.

### Opting another SDK in

One line in that SDK's `registerRoutes`, plus a dependency:

```ts
// packages/sdk-<name>/src/server/routes.ts
import { requireAuthOrApiKeyForDomain } from '@projexlight/sdk-api-keys';
const requireAuth = requireAuthOrApiKeyForDomain('<domain>');
```

```jsonc
// packages/sdk-<name>/package.json
"@projexlight/sdk-api-keys": "workspace:*"
```

Deriving the scope from the route pattern means a **newly added route is covered
the moment it exists** — no per-route scope string to forget, and no silent
JWT-only default.

If that SDK's handlers read `req.auth`, keep the type available by importing
`SixLayerJwtClaims` from `@projexlight/sdk-api-keys` (it re-exports it precisely so
the `FastifyRequest.auth` module augmentation travels with the guard that
populates it). Dropping the direct `sdk-identity` import without this produces
`Property 'auth' does not exist`.

The middleware lives in `sdk-api-keys` rather than `sdk-identity` because
`sdk-api-keys` already depends on `sdk-identity`; the reverse would be circular.

## 6. Rotate and revoke

| Operation | Call | Behaviour |
|-----------|------|-----------|
| List | `GET /api/api-keys?tenant_id=…` | Display prefix only, never the key |
| Rotate | `POST /api/api-keys/:key_id/rotate` | `201` with a new plaintext; the old key stays valid for a 24h grace window |
| Revoke | `POST /api/api-keys/:key_id/revoke` | Immediate, broadcast over Redis to every gateway replica within ~1s |

Zero-downtime rotation: rotate → deploy the new key → confirm traffic on the new
prefix via `last_used_at` → **revoke the old key**. Skipping that last step leaves
a live credential in the wild once the grace window lapses.

Issuance, rotation and revocation each emit an audit event
(`api-key.issued.v1` / `.rotated.v1` / `.revoked.v1`), so custody is reviewable.

## 7. Troubleshooting

| Symptom | Cause | Fix |
|---------|-------|-----|
| `401 Missing bearer token` | No `Authorization`, or key sent as `x-api-key` | Send `Authorization: Bearer pk_live_…` |
| `401 API key invalid, revoked, or expired` | Wrong/revoked/expired key, or a key from the other environment | `GET /api/api-keys?tenant_id=…`; confirm the gateway you are pointed at |
| `403 …missing required scope(s)` | Key lacks the derived scope | Response lists `required_scopes` and `granted_scopes`; re-issue or rotate with it |
| `403 …issued for a different tenant` | Payload `tenant_id` ≠ key's tenant | Send the key's own tenant id |
| `404` on a plausible path | `/{sdk}/v1/…` style URL | Use the real `/api/<domain>/…` route |
| Works locally, `401` in cloud | Dev key against the hosted gateway | One key per environment |

## 8. Hardening notes

Two conscious trade-offs, recorded so nobody has to rediscover them:

**Static salt.** `hashKey()` uses a fixed salt, which is what lets `verifyKey()`
do an indexed `WHERE key_hash = $1`. A per-key random salt would force a table
scan per request. With 192 bits of key entropy, precomputation is infeasible, so
this is defensible. The textbook upgrade is to split the key into a public
`key_id` and a secret half — look up by `key_id`, verify the secret against a
per-key salted hash — which keeps O(1) lookup. That is the Stripe/GitHub shape and
a worthwhile future change.

**Long-lived bearer secret.** Scoped, hashed, rotatable keys are the right tier
for this integration, but the stronger pattern is exchanging a key for a
short-lived token at the gateway edge so the key never travels further in.
Additive, and invisible to callers when it lands.
