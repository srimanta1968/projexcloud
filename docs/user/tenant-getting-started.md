# Tenant — Getting Started (Trial Workspace)

**Audience:** the person who just signed up for a free ProjexCloud trial
(the first user of a brand-new tenant, who is automatically promoted to
tenant admin).
**Where you are:** `http://localhost:3000` — the **tenant workspace**.
**Backed by:** api-gateway on `http://localhost:3500` via `/api/*` routes,
authenticated with the six-layer JWT you just received.

After signup you should see a screen like:

> Welcome to **PROJEXLIGHT INC**.
> Your trial workspace is live. You're signed in as `jana.srimanta@gmail.com`
> and have been added as its admin.
>
> Tenant ID, App ID, Org ID, Region — all printed for reference.

Those IDs are the six-layer scope on your JWT. Every API call you make is
filtered through them, so you can only ever see your own tenant's data.
This guide walks you through a ~15-minute first-run path so you know the
trial works end-to-end.

---

## 1. Look at your workspace dashboard

Go to `http://localhost:3000/dashboard`. You should see:

- **Active session** card — your email, Tenant ID, App ID, Org ID, and
  session expiry. This is your JWT decoded client-side (display only;
  the gateway re-verifies on every request).
- **In-workspace tools** — three tiles:
  - **Build with AI** → `/build` — chat-driven app scaffolding from
    vertical blueprints (covered in §5 below).
  - **Audit ledger** → `/admin/audit` — append + verify the
    tamper-evident chain.
  - **Key hierarchy** → `/admin/keys` — read-only view of the vault
    key tiers and their status.
- **Other consoles** — external links to:
  - **Tenant Admin** at `http://localhost:3200` (covered in §2).
  - **Platform Console** at `http://localhost:3100` — operator-only;
    you won't be able to sign in here with a tenant identity.

If the dashboard kicks you back to `/login`, your JWT didn't land in
localStorage. Re-do the signup or `/login` flow and check the browser
devtools → Application → Local Storage for the `projex_token` key.

---

## 2. Visit the Tenant Admin console

Click **Tenant Admin** on the dashboard, or open
`http://localhost:3200` directly. Sign in with the same credentials you
used at signup. You should see a sidebar with:

- **Billing** — live meter + invoices (empty for a fresh trial).
- **Members** — personas, roles, BUs.
- **API keys** — long-lived machine credentials.
- **Webhooks**, **Connectors**, **Approvals**, **Consent**, **BYOK**, **MCP servers**.

The full reference for this console is in
[`tenant-admin-guide.md`](./tenant-admin-guide.md). For testing, the
two highest-signal screens are **Members** and **API keys**.

### 2a. Add a teammate (Members)

1. **Members** → **Add persona**.
2. Kind: pick `human` for a test invite, or `service` for a machine
   identity.
3. Assign at least one role from the role catalogue.
4. Save.

Watch the audit panel — a `member.added` entry should land within a
second or two. That's `sdk-audit` writing to your tamper-evident ledger.

### 2b. Issue an API key

1. **API keys** → **Issue key**.
2. Pick a service persona (create one in §2a if needed).
3. Pick scopes (minimum privilege: `tenant.read` is enough for the
   call in §3).
4. (Optional) set an expiry.
5. Save and **copy the secret immediately** — it is shown once.
   ProjexCloud only stores a hash.

Keep the secret in your clipboard for §3.

---

## 3. Make a first authenticated API call

You can authenticate with either the JWT (from signup) or the API key
(from §2b). The JWT is short-lived (7 days by default — see
`JWT_EXPIRES_IN` in `.env`); the API key is long-lived.

### With the JWT

Grab your token from browser devtools → Application → Local Storage →
`projex_token`, then:

```powershell
curl http://localhost:3500/api/userinfo `
  -H "Authorization: Bearer <paste-jwt-here>"
```

Expected: a JSON body with your `sub`, `email`, `tenant_id`, `app_id`,
`org_id` — the same scope your dashboard showed. A 401 means the JWT
expired or didn't make it through; a 404 means the api-gateway hasn't
mounted `sdk-identity`'s routes (rebuild the SDK — see §7).

### With the API key

```powershell
curl http://localhost:3500/api/userinfo `
  -H "Authorization: Bearer <paste-api-key-here>"
```

If both work, your six-layer JWT pipeline is alive end-to-end:
signup → token mint → middleware verify → tenant-scoped response.

---

## 4. Watch usage land on the meter

API calls you make are metered by `sdk-meter`. After the calls in §3:

1. Tenant Admin → **Billing** → **Live meter**.
2. Wait ~60s (the meter refreshes on that cadence).
3. You should see at least one row — usually a `identity.userinfo` SKU
   with a small request count. If the meter is empty, the call
   bypassed metering — most often because Redis isn't enabled (see
   `REDIS_ENABLED` in `.env`; the soft-cap path requires it).

---

## 5. Try the AI scaffolding flow (`/build`)

Back in the workspace, go to `http://localhost:3000/build`. This is
the cloud agent surface — it takes a natural-language project
description, matches it against the vertical blueprint catalogue
(`Field-service dispatch`, `Insurance claims intake`, `B2B SaaS analytics`,
`Healthcare patient portal`, `RevOps CRM`), and scaffolds a starter
workspace inside your tenant's pool.

Try a prompt like:

> *"I want a small lead-scoring app for my SaaS sales team."*

Expected flow: blueprint match → 2–3 clarifying questions → scaffold
plan. The full deploy step ("hand me a URL in 5 minutes") requires the
cloud builder to be running; in a local dev environment you may see the
plan but not a deployed app.

> **Note on scope:** `/build` is the most ambitious part of the
> product. If it errors out, it's the most likely thing to be
> half-wired in a fresh dev environment — not a fault of your signup.

---

## 6. Optional: inspect the audit ledger and key hierarchy

These are read-only views that confirm the platform's compliance plumbing
is working for your tenant.

- **Audit ledger** (`/admin/audit`) — append a manual entry, then click
  **Verify chain** to confirm the hash chain is unbroken. Every
  admin-side action (member add, API key issue, etc.) appends here.
- **Key hierarchy** (`/admin/keys`) — visualises the four-tier vault
  hierarchy (Platform KEK → Tenant KEK → DEKs → Per-resource keys).
  In a fresh trial only the top tiers are populated; per-resource keys
  appear as you encrypt data through `sdk-vault`.

---

## 7. Troubleshooting

### Signup returned 404 on `/api/auth/signup-tenant`
The `@projexlight/sdk-identity` package's `dist/` is stale (was built
before `signup-tenant` was added). Rebuild and restart:

```powershell
pnpm --filter @projexlight/sdk-identity build
# then stop and restart `pnpm dev`
```

The same applies to any other route registered in an SDK but not in
the gateway's own `src/`.

### `http://localhost:3200` shows "site can't be reached"
The tenant-admin app isn't running. Either `pnpm dev` didn't start
it (turbo runs every `dev` script in parallel — check the terminal
output for compile errors), or you can start it on its own:

```powershell
pnpm --filter tenant-admin dev
```

Same pattern for the other apps: `tenant-workspace`, `projexcloud-admin`,
`@projexlight/api-gateway`.

### `http://localhost:3100` (Platform Console) refuses to sign in
This console is for ProjexCloud platform staff, not tenant users.
It requires `ADMIN_OPS_TOKEN` (set in `.env`). Your tenant credentials
will not work here — by design.

### The dashboard keeps redirecting to `/login`
Either your JWT expired, or it didn't land in localStorage. Sign in
again at `/login` (not `/signup` — that creates a *new* tenant). If
sign-in succeeds but the dashboard still redirects, check that
`projex_token` is present in Local Storage and that `NEXT_PUBLIC_API_BASE`
points at the right gateway (`http://localhost:3500` by default).

### "JWT signature invalid" on `/api/userinfo`
The gateway's `JWT_SECRET` changed between when the token was minted
and when it's being verified. Sign in again to mint a fresh token, or
restore the previous `JWT_SECRET` value in `.env`.

---

## 8. Where to go next

- **Daily operations** of your tenant → [tenant-admin-guide.md](./tenant-admin-guide.md).
- **Platform-level operations** (mostly for ProjexCloud staff, not tenants) → [platform-admin-guide.md](./platform-admin-guide.md).
- **Architectural roadmap** for the SDK capability registry, MCP, vertical packs, and the local CLI flow → [Next-steps.md](./Next-steps.md).
- **Identity model** (the six-layer JWT, persona vs subject vs alias, federation, SCIM, SAML) → P2 docs under `docs/v3.1/`.
