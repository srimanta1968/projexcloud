# Tenant Application Credentials — EP-386

**Created:** 30 July 2026 · **Project:** ProjexCloud (`cf30e9b7`) · **Sprint:** Sprint3 (`d4876947`)
**Imported:** `EP-386` (epic `783fc94b-6992-49a5-a492-74ee0450a92f`), 10 features, 12 scenarios, `TK-4105` … `TK-4124`

Lets a customer's own application call ProjexCloud server-to-server with a scoped, revocable
machine credential instead of a human's email and password.

---

## Why this epic exists

`sdk-api-keys` shipped a complete lifecycle, three SDKs opted in, a portal page was written and a
detailed developer-hub guide was published — and **none of it worked end to end**. The audit that
produced this epic (30 July 2026) found:

| # | Finding | Where |
|---|---|---|
| 1 | **No key can reach any route.** The default-deny gate runs the JWT-only `requireAuth` as a root `onRequest` hook; Fastify runs `onRequest` before every route `preHandler`, so a `pk_live_` bearer fails `verifyJwt` and 401s platform-wide | `services/api-gateway/src/plugins/authGate.ts:141` |
| 2 | **Cross-tenant takeover.** Issue/list/revoke/rotate read `tenant_id`/`key_id` from the request and never compare to `req.auth.tenant_id`, so tenant A can rotate tenant B's key and read the new plaintext | `packages/sdk-api-keys/src/server/handlers/apiKeyController.ts` |
| 3 | **Coverage is 3 of ~68** mounted route modules, by per-SDK opt-in; a new route silently defaults to JWT-only | `sdk-sla`, `sdk-assignment`, `sdk-notification` |
| 4 | **Hot path.** `crypto.pbkdf2Sync` at 310,000 iterations synchronously per request, blocking the event loop, plus a DB write per hit; nothing subscribes to the `api-key:revoked` channel; `rate_limit_rpm` is never enforced | `apiKeyService.ts` |
| 5 | **Schema cannot express per-app keys** — no application, name, `created_by` or environment column, while the code hard-codes `pk_live_` and the docs promise `pk_test_` | `001_init_api_keys.sql` |
| 6 | **Two competing surfaces** (`/api/api-keys/*` and an inline `/api/keys/*` block) and a portal UI that matches neither and sends no `Authorization` header | `app.ts:3403`, `apps/tenant-admin/src/app/api-keys/page.tsx` |
| 7 | **Docs ahead of the code** — a navigation path that does not exist, `:3000` for a gateway on `:4000`, and key auth presented as generally available | `docs/v3.1/developer-hub/` + 2 portal copies |

Correctly excluded and left alone: `/admin/*`, `/api/admin/*` (ADMIN_OPS_TOKEN), `/scim/*` and the
robot command-ack leaf self-guard with their own credentials and must keep refusing a tenant key.

---

## Design decision (30 July 2026)

**Per-application keys backed by an application registry — not one global key per tenant.** This is
the industry norm (Stripe restricted keys, SendGrid named keys, Twilio, AWS IAM, Auth0 M2M clients).
A global key means a leak forces every integration to rotate at once, rotation needs coordinated
downtime, and no call can be attributed to an app.

**Two authentication paths, both supported.** Direct `Authorization: Bearer pk_...` at the gate for
DX, and RFC 6749 `client_credentials` exchange for a short-lived service JWT. The exchange is the
mature form *and* the cheap one: every route already verifies JWTs, so it covers all ~68 SDKs with
no route edits and moves PBKDF2 off the per-request path to once per token.

---

## Imported IDs

Epic `PC-13` → `783fc94b-6992-49a5-a492-74ee0450a92f` (**EP-386**)

| temp | feature | id | tasks |
|---|---|---|---|
| PCF-13-1 | Application registry and per-app key schema | `e6559180-528c-4faf-a80c-d08dee9c2ed5` | TK-4105 |
| PCF-13-2 | Lifecycle with tenant-scoped authorization | `ec157bd5-4d94-4515-87cc-1c00b938c0a5` | TK-4106, TK-4107 |
| PCF-13-3 | Gateway key authentication at the gate | `13eb07a5-45df-4d10-b60f-da0f05883225` | TK-4108, TK-4109 |
| PCF-13-4 | Hot path — HMAC, cache, revocation | `05d7d6ff-dba8-4d00-b924-7f8a1060bad5` | TK-4110, TK-4111 |
| PCF-13-5 | Rate limiting and usage metering | `60215dd9-18db-4b05-96c4-9e44223c38da` | TK-4112, TK-4113 |
| PCF-13-6 | Client-credentials token exchange | `f45b599e-69b8-41f7-808a-e4ba7374acd6` | TK-4114, TK-4115 |
| PCF-13-7 | One key surface | `888ec9d8-5cbb-4d77-9082-fd78b08334ad` | TK-4116, TK-4117 |
| PCF-13-8 | Tenant portal — Applications and keys | `9a37285f-2d28-46be-9c3b-3e028e15e5a5` | TK-4118, TK-4119, TK-4120 |
| PCF-13-9 | Developer hub corrections | `dc4d1817-bee2-4604-a423-5aefc7f636bd` | TK-4121 |
| PCF-13-10 | Coverage gate | `c9893cda-7dc5-453a-9501-d4b193471cac` | TK-4122, TK-4123, TK-4124 |

---

## Build order

Dependency-correct, not task-number order:

1. **TK-4105** schema — everything else needs `application_id` and `key_lookup`
2. **TK-4110** HMAC lookup + dual-read — the token exchange and the gate both call `verifyKey`
3. **TK-4106 / TK-4107** application service + tenant-scoped lifecycle
4. **TK-4114** token exchange — the cheap route to all ~68 SDKs
5. **TK-4108 / TK-4109** the gate + central scope derivation
6. **TK-4111 / TK-4112 / TK-4113** cache, rate limit, metering
7. **TK-4116 / TK-4117** route surface + retire the inline block
8. **TK-4118–4120** portal UI
9. **TK-4122–4124** gates and the live journey, then **TK-4121** docs last so they describe what shipped

## Files here

- `epics-features-scenarios.json` — the imported epic/feature/scenario payload
- `tasks.json` — the imported task payload, keyed by `feature_temp_id` / `epic_temp_id`
