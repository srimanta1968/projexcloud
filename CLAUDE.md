# ProjexCloud — agent guidance

## This is NOT ProjexCRM

ProjexCloud (`projex_verticals/ProjexCloud`) is a **docker-compose monorepo** — a
Fastify api-gateway that mounts ~90 workspace SDKs, three Next.js portals, and
Postgres/Redis/ClickHouse. It has **nothing to do with `crm-server.sh deploy`**,
which belongs to the separate **ProjexCRM** project (`projex_crm`). Do not use
`crm-server.sh` here.

## Production

- Host: `ec2-user@ec2-54-234-19-226.compute-1.amazonaws.com`
- Key: `C:\Users\srima\ProjectX\ProjexCloud.pem`
- Repo on host: `/home/ec2-user/projexcloud` (tracks `origin/main`)
- Stack: two compose projects — `projexcloud-prod` (api-gateway + Postgres +
  Redis + ClickHouse + registry-mcp) and `projexcloud-portals` (workspace /
  tenant / console). nginx (`cloud.projexlight.com`) fronts gateway :3000 and
  the portals.

## Deploy

Run these **on the prod host, from `/home/ec2-user/projexcloud`, with `.env.prod`
present.**

**Incremental redeploy of changed service(s) — the normal path:**

```bash
scripts/setup/deploy-service.sh api-gateway
# multiple: scripts/setup/deploy-service.sh api-gateway portal-console
# skip the git pull: NO_PULL=1 scripts/setup/deploy-service.sh api-gateway
```

It `git pull --ff-only origin main`, then rebuilds only the named service
image(s) and recreates just those containers, then health-gates the gateway.
Builds are **turbo/BuildKit-incremental**: the pnpm store and `.turbo` cache are
persisted BuildKit cache mounts, so unchanged packages restore their `dist/`
from cache and only changed packages (+ dependents) recompile. A one-file change
rebuilds in minutes, not a full ~90-package compile. Requires BuildKit
(`DOCKER_BUILDKIT=1`, set by the script).

**No-build reconcile / boot / registry deploy:**

```bash
./deploy.sh up      # reconcile to desired state with current images (no build)
./deploy.sh deploy  # registry pull then up (when IMAGE_PREFIX/TAG set)
./deploy.sh ps | logs <svc>
```

`deploy.sh` is the single source of truth for the multi-file compose invocation
(also used by the `projexcloud.service` systemd unit on boot), so the same file
set + profiles (`--profile selfhosted --profile discovery`) are always applied.

## Build notes

- The api-gateway Dockerfile COPYs the whole `packages/`, `services/`, `native/`,
  `tools/` trees and runs `pnpm -w build`, so **every** SDK is compiled. A new
  SDK is only *served*, though, if it is a `workspace:*` dep in the gateway
  `package.json` **and** registered via `app.register(...)` in
  `services/api-gateway/src/app.ts`. The build won't error if you forget — the
  route just silently won't exist. Add the dep + the register line.

## Audit events

- Every event name follows `<domain>.<entity>.<verb>.v<N>` — lowercase, `-`/`_`
  inside a segment, and the **`.v<N>` suffix is mandatory**. It is what lets a
  payload shape change later as a new version instead of silently redefining
  rows already written under the old shape. Enforced by
  `EVENT_TYPE_NAME_PATTERN` in `packages/contracts/src/events.ts`.
- Platform code declares its types in the `EVENT_TYPE_REGISTRY` constant there.
  A **consuming application** registers its own at runtime with
  `POST /api/events/types` (tenant-scoped, additive) — it must not add to the
  constant or reuse a platform name. Resolution is baseline-first then tenant,
  so a tenant type can never shadow a platform one. See
  `docs/CONSUMPTION-CONTRACT.md` §2.1.
- OC-2 still holds: a type in neither place is rejected before any write. But
  note `emitEvent` **swallows** failures by design, so a rejected append looks
  like a transient blip and an empty chain verifies clean — check `audit.entry`
  rather than trusting a 2xx.

## Auth

- Gateway auth is a **default-deny gate** (`services/api-gateway/src/plugins/authGate.ts`,
  one root `onRequest` hook): a valid tenant JWT is required unless the path is
  on the public allowlist (auth/health/well-known/storm/metrics, SAML, OAuth
  callback, signature webhooks), self-guards as admin (`ADMIN_OPS_TOKEN` via
  `checkAdminToken`/`requireAdmin`), or is a WebSocket upgrade.
- Kill-switch: `AUTH_GATE_MODE=enforce` (default) `| report | off` in `.env.prod`.
  Flip without a rebuild: `docker compose ... up -d --force-recreate api-gateway`.
- One operator secret: `ADMIN_OPS_TOKEN` (the former `FEDERATION_ADMIN_TOKEN` was
  consolidated into it).

## ClickHouse

- Sized for the 1.4 GB container in `infra/clickhouse/config.d/tuning.xml`
  (self-telemetry `*_log` tables disabled, caches shrunk, `SYS_NICE`). Do NOT
  leave defaults — they assume a ~64 GB box and spiral the container. Server
  log-file rotation is capped in `infra/clickhouse/config.d/logging.xml`.
