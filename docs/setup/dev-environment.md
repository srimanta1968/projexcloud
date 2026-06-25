# Developer Environment Setup

How to run the full ProjexCloud stack on your machine. This replaces the removed
dev container — everything now runs natively with a single Postgres container.

## 1. Prerequisites

| Tool | Version | Notes |
|------|---------|-------|
| **Node.js** | 20 LTS | `node -v` must be ≥ 20 |
| **pnpm** | 9 | Ships via corepack: `corepack enable` (pinned by `package.json`) |
| **Docker** | latest | Docker Desktop on Windows/macOS; Engine on Linux — used for Postgres |
| **Git** | any | On Windows, the bundled **Git Bash** runs `dev-setup.sh` |

> The `@projexlight/*` packages resolve from the workspace (`workspace:*`), not
> from a registry — you do **not** need Verdaccio for local dev.

## 2. Quick start (one command)

From the repo root (`C:\Users\srima\projex_verticals\ProjexCloud`):

```powershell
# Windows (PowerShell)
./scripts/setup/dev-setup.ps1 -Seed
```
```bash
# macOS / Linux / WSL / Git Bash
./scripts/setup/dev-setup.sh --seed
```

The script will:

1. Verify Node/Docker/pnpm.
2. Create `.env` from `.env.example` and add a random `ADMIN_OPS_TOKEN`
   (needed for `/admin/*` endpoints and seeding) plus `KAFKA_ENABLED=false`.
3. `docker compose up -d postgres` (data persists in the `postgres_data` volume).
4. `pnpm install` then `pnpm -w build`.
5. With `-Seed`/`--seed`: start the gateway in the background and run
   `seed-dev-data.mjs`.

Drop `-Seed`/`--seed` to stop after the build and run the gateway yourself.
Use `-SkipBuild`/`--skip-build` on later runs once `dist/` exists.

## 2a. Database prerequisites (important)

The api-gateway runs every SDK migration on boot and **aborts** if the Postgres
cluster is missing required extensions or already holds a conflicting schema:

- **pgvector** — needed by `sdk-agent-runtime` (`extension "vector" is not available` if absent).
- **PostGIS** — needed by `sdk-geo` (`sdk-geo requires PostGIS` if absent).
- **A clean database** — point the gateway at an **empty** DB. A database
  pre-seeded by the ProjexLight CLI export (`init-scripts/01-schema.sql`, which
  creates a bare `public.users` table) collides with `sdk-identity`
  (`column "email" does not exist`). Keep the platform DB separate from any
  ProjexLight-export DB.

The bundled Postgres image (`scripts/setup/postgres.Dockerfile`, used by
`docker-compose.yml`) **bakes in both extensions**. If you point at an existing
container instead, `dev-setup` runs `scripts/setup/ensure-pg-extensions.sh`,
which detects the container behind `DB_PORT`, installs any missing extension
(version-matched via apt), and **aborts setup if it can't** — so you never reach
a doomed boot. Run it standalone any time:

```bash
DB_PORT=5432 bash scripts/setup/ensure-pg-extensions.sh        # auto-detects the container
# PowerShell:
./scripts/setup/ensure-pg-extensions.ps1 -DbPort 5432
```

## 3. What happens on first boot (auto-migration)

The api-gateway calls `runMigrations([...])` for **every SDK in dependency
order** during startup (P1 foundations → P2 identity/access → P3 canonical +
privacy → … → P10 governance). Migrations are forward-only and sha256-tracked,
so re-running the gateway is safe and idempotent. **You never run SQL by hand.**

A clean boot log ends with:

```
api-gateway listening on :3000
```

## 4. Manual run (what the script automates)

```bash
cp .env.example .env                       # then set ADMIN_OPS_TOKEN=<random hex>
docker compose up -d postgres              # Postgres on :5432
pnpm install
pnpm -w build                              # or build just the gateway's deps
pnpm --filter @projexlight/api-gateway dev # ts-node-dev, hot reload, runs migrations
```

In a second terminal:

```bash
curl http://localhost:3000/health
# {"status":"ok","service":"projex-api-gateway",...}
node scripts/setup/seed-dev-data.mjs       # pricing catalogs + dev tenant
```

## 5. Seed data

`scripts/setup/seed-dev-data.mjs` adds **data only** (schema is already
migrated):

- **Pricing catalogs** — every file in `seeds/pricing-catalog/*.json`, applied
  through `scripts/apply-pricing-seed.mjs` (sdk-meter catalogs + rates, left in
  `draft` status for review).
- **A development tenant** — `POST /admin/tenants` with `app_id=dev-app`
  (needs the gateway running and `ADMIN_OPS_TOKEN` set).

Options:

```bash
node scripts/setup/seed-dev-data.mjs --pricing-only      # skip the tenant
node scripts/setup/seed-dev-data.mjs --tenant-only       # skip pricing
node scripts/setup/seed-dev-data.mjs --gateway http://localhost:3000
```

It is idempotent — pricing rates upsert and a duplicate tenant is skipped.

## 6. Optional services & front-ends

| Component | Command | URL / Port |
|-----------|---------|-----------|
| api-gateway | `pnpm --filter @projexlight/api-gateway dev` | http://localhost:3000 |
| ProjexCloud admin | `pnpm --filter @projexlight/projexcloud-admin dev` | http://localhost:3100 |
| Tenant admin | `pnpm --filter @projexlight/tenant-admin dev` | http://localhost:3200 |
| Tenant workspace | `pnpm --filter @projexlight/tenant-workspace dev` | http://localhost:3000 ⚠ clashes with gateway — run with `next dev -p 3300` |
| Semantic service | `pnpm --filter @projexlight/service-semantic dev` | :8082 |

### Enabling Redis / Kafka / ClickHouse locally

The gateway works with Postgres alone, but to exercise the Redis-backed route
cache and soft-cap counter, start a Redis container and set in `.env`:

```bash
docker run -d --name projex-redis -p 6379:6379 redis:7-alpine
# .env:  REDIS_ENABLED=true  REDIS_HOST=localhost  REDIS_PORT=6379
```

Kafka and ClickHouse are off by default for dev; enable only if you are working
on usage-event streaming or OLAP trace features (`KAFKA_ENABLED=true`,
`CLICKHOUSE_ENABLED=true`, with brokers/URL set).

## 7. Common tasks

```bash
pnpm -w build                 # build all packages/services
pnpm test                     # turbo test across the workspace
pnpm lint                     # eslint
docker compose logs -f postgres
docker compose down           # stop Postgres (keeps the volume)
docker compose down -v        # stop + wipe the database volume (fresh start)
```

## 8. Troubleshooting

| Symptom | Fix |
|---------|-----|
| `extension "vector" is not available` | Postgres lacks pgvector — run `scripts/setup/ensure-pg-extensions.sh` (or use the bundled image) |
| `sdk-geo requires PostGIS` | Postgres lacks PostGIS — same fix as above |
| `column "email" does not exist` during `sdk-identity` migration | DB was pre-seeded by the ProjexLight export (`init-scripts`); use a fresh/empty database for the platform |
| `ECONNREFUSED 127.0.0.1:5432` | Postgres container not up — `docker compose up -d postgres` |
| Gateway exits during migrations | Check Postgres is reachable and `DB_*` in `.env` match the container; `docker compose logs postgres` |
| `401` from `/admin/tenants` while seeding | `ADMIN_OPS_TOKEN` in `.env` must equal what the gateway booted with; restart the gateway after editing `.env` |
| `pnpm: command not found` | `corepack enable`, or `npm i -g pnpm@9` |
| Port 3000 already in use | Set `PORT=3001` in `.env` (and pass `--gateway http://localhost:3001` to the seeder) |
| Want a totally clean DB | `docker compose down -v && docker compose up -d postgres` then restart the gateway |
