# ProjexCloud — Setup Documentation

This folder is the entry point for standing up ProjexCloud, both for developers
and for DevOps deploying to a cloud. It replaces the removed dev container.

## What ProjexCloud is (the 60-second version)

A **pnpm + turbo monorepo** (Node 20). The runtime surface is a single Fastify
service, **`services/api-gateway`** (port `3000`), that imports ~90 workspace
SDKs and **auto-runs every SDK's database migration on boot, in dependency
order** — there is no manual SQL/migration step. Supporting services
(projectors, semantic, meter-collector, pool-federation) are optional
scale-out workers.

| Dependency | Required? | Default | Behaviour if absent |
|------------|-----------|---------|---------------------|
| PostgreSQL | **Yes** | `localhost:5432` | Gateway cannot start |
| Redis | Recommended | on (`REDIS_ENABLED`) | Falls back to in-memory route cache |
| Kafka | Optional | on (`KAFKA_ENABLED`) | Falls back to in-process event emitter |
| ClickHouse | Optional | off (`CLICKHOUSE_ENABLED`) | Trace/telemetry use Postgres mirror |
| OpenSearch | Optional | off | `sdk-search` uses Postgres fallback |

## Documents

| Doc | Audience | Use it to… |
|-----|----------|-----------|
| [dev-environment.md](./dev-environment.md) | Developers | Run the full stack locally on Windows/macOS/Linux |
| [production-overview.md](./production-overview.md) | DevOps | Understand the prod architecture, env, migrations, seeding, scaling & security — **read first** |
| [production-aws-ec2.md](./production-aws-ec2.md) | DevOps (AWS) | Deploy on EC2 + RDS + ElastiCache (+ optional MSK) |
| [production-digitalocean.md](./production-digitalocean.md) | DevOps (DigitalOcean) | Deploy on a Droplet + Managed Postgres + Managed Redis |
| [local-llm-and-discovery.md](./local-llm-and-discovery.md) | Both | How the SDK-discovery embedding model (in-process, no container) and the optional on-prem LLM are set up in dev & prod |

> Kubernetes / sovereign-region deployments use the Helm + Terraform starter in
> [`deploy/sovereign/`](../../deploy/sovereign/README.md) — out of scope here.

## Scripts (all under [`scripts/setup/`](../../scripts/setup/))

| Script | Purpose |
|--------|---------|
| `dev-setup.ps1` / `dev-setup.sh` | One-shot **developer** bootstrap (prereqs → .env → Postgres → install → build → optional seed) |
| `ensure-pg-extensions.sh` / `.ps1` | Detect the Postgres container behind `DB_PORT` and **auto-install pgvector + PostGIS** if missing (aborts if it can't). Run by `dev-setup`/`prod-setup`; usable standalone |
| `postgres.Dockerfile` | Bundled Postgres image with **PostGIS + pgvector** baked in (used by the dev and prod-selfhosted Compose stacks) |
| `seed-dev-data.mjs` | Idempotent **data seed**: pricing catalogs + a development tenant. Schema is auto-migrated by the gateway, so this only adds data |
| `prod-setup.sh` | **Production** bootstrap on a Linux host (Docker Compose), cloud-agnostic |
| `docker-compose.prod.yml` | Production stack (api-gateway built from source + Postgres + Redis; Kafka/ClickHouse opt-in) |
| `.env.prod.example` | Production environment template |

### Is there one script that builds the whole dev env with seed data?

Yes. From a clean checkout:

```bash
# Windows (PowerShell)
./scripts/setup/dev-setup.ps1 -Seed
# macOS / Linux / WSL / Git Bash
./scripts/setup/dev-setup.sh --seed
```

That single command checks prerequisites, writes `.env`, starts Postgres,
installs and builds the workspace, boots the gateway (which migrates every SDK
schema), then runs `seed-dev-data.mjs` for the baseline metadata and a dev
tenant.

### Is there a prod setup script per cloud?

There is **one** parameterized script, `prod-setup.sh`, that runs on any Linux
VM (EC2, Droplet, bare VM). Cloud differences are **managed-service and
networking steps done outside the script** (creating the VM, RDS/ElastiCache vs
DO Managed DB/Redis, firewalls, TLS) — those are documented in each
cloud-specific guide. Run `prod-setup.sh --mode managed` once the managed
Postgres/Redis exist, or `--mode selfhosted` to run everything in containers on
the one host.
