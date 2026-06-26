# Tenant Admin console — known issues & follow-up plan

Status as of 2026-06-26. The Tenant Admin console (`/tenant`, app `apps/tenant-admin`)
is a single-tenant operator console that reads its target tenant from env and
calls the api-gateway directly. Two classes of issues remain after the config
fix; this doc is the plan to close them.

## What the config fix already did (shipped)

- `portal-tenant` now reads `TENANT_ADMIN_TENANT_ID` at runtime
  (`scripts/setup/docker-compose.portals.yml` → host `scripts/setup/.env`).
- With it set to the live tenant, **Connectors** and **Webhooks** pages work,
  and the "Set TENANT_ADMIN_TENANT_ID" banners clear.

## Issue 1 — gateway 500s (`column "tenant_id" does not exist`)

Pages: **Members, API keys, Approvals, Consent** (and any handler that filters a
table by a non-existent `tenant_id` column).

Root cause: these gateway/SDK handlers query e.g. `persona.persona` with
`WHERE tenant_id = $1`, but that table has **no** `tenant_id`. Tenant scope lives
on `identity.tenant_membership.tenant_id`, joined via `persona.persona.membership_id`.

Confirmed schema:
- `persona.persona(persona_id, membership_id, kind, primary_role_template_id, bu_id, persona_key_ref, status, created_at, shredded_at)`
- `identity.tenant_membership(membership_id, person_id, tenant_id, bu_id, role_template_id, status, created_at)`
- There **is** 1 membership for the live tenant, so data exists — only the query is wrong.

Fix:
1. Find each failing handler (gateway route or the owning SDK package, e.g. the
   persona/identity SDK) and rewrite the query to join through
   `identity.tenant_membership` (e.g. `JOIN identity.tenant_membership m ON
   m.membership_id = p.membership_id WHERE m.tenant_id = $1`).
2. Add a regression test per endpoint (list returns the seeded member).
3. Rebuild + redeploy the api-gateway:
   `docker compose --env-file .env.prod -f scripts/setup/docker-compose.prod.yml ... build api-gateway && up -d api-gateway`.

## Issue 2 — 401s (`requireAuth` needs a Bearer JWT)

Pages: **Billing, AI Providers, MCP Servers**. These gateway routes use
`requireAuth` (`packages/sdk-identity/src/middleware/authMiddleware.ts`), which
requires `Authorization: Bearer <six-layer JWT>`. The console has no sign-in, so
it sends none → 401.

Chosen direction: **give Tenant Admin a real login** (most correct).

Plan:
1. Reuse the Workspace auth pattern (`apps/tenant-workspace` LoginForm + token
   storage). Add a `/login` to `apps/tenant-admin` that obtains the gateway JWT.
2. Client pages (e.g. `ai/mcp-servers/page.tsx`) send
   `Authorization: Bearer <token>` (drop the empty `NEXT_PUBLIC_TENANT_ID` and
   read tenant from the JWT claims instead).
3. Server-rendered pages: forward the caller's token from the request to the
   gateway fetch (read it from the session cookie in the server component).
4. Derive tenant from the authenticated session, retiring `TENANT_ADMIN_TENANT_ID`
   as the source of truth (keep only as an operator override).
5. Gate `/tenant` (and `/console`) at nginx or in-app so the console isn't
   reachable unauthenticated.

## Notes
- `NEXT_PUBLIC_TENANT_ID` (build-time) is read only by the MCP client page and is
  blocked by Issue 2 anyway, so it was intentionally left unset until login lands.
- Only one tenant exists today: `PROJEXLIGHT INC`
  (`app_id projexlight-inc-…`). DB is `projexcloud_db` on `projexcloud_pg`.
