# Production Setup — Overview (read first)

Shared concepts for deploying ProjexCloud to any cloud. The cloud-specific
guides ([AWS EC2](./production-aws-ec2.md),
[DigitalOcean](./production-digitalocean.md)) only cover the parts that differ
(VM creation, managed Postgres/Redis, firewalls, TLS). Everything below is
common to all of them.

## 1. Architecture in production

```
            ┌───────────────────────┐
   HTTPS    │  Load balancer / TLS  │   (ALB / DO LB / Nginx + certbot)
  ───────▶  │  reverse proxy        │
            └──────────┬────────────┘
                       │ :3000
            ┌──────────▼────────────┐
            │   api-gateway         │  Fastify; imports ~90 SDKs;
            │  (Docker container)   │  auto-runs all migrations on boot
            └───┬─────────┬─────────┘
                │         │
        ┌───────▼──┐  ┌───▼───────┐   (optional)
        │ Postgres │  │  Redis    │   Kafka / ClickHouse / OpenSearch
        │ (managed)│  │ (managed) │
        └──────────┘  └───────────┘
```

The **api-gateway is the only required compute**. The other services
(`identity-projector`, `lineage-projector`, `meter-collector`,
`pool-federation-runtime`, `semantic-service`) are optional scale-out workers
you add once traffic warrants — each has its own Dockerfile and reads the same
env. See [Scaling](#7-scaling-out) and `docs/v3.1/SCALING-RUNBOOK.md`.

## 2. Two deployment modes

`scripts/setup/prod-setup.sh` supports both:

| Mode | What runs in Docker on the VM | Postgres / Redis | When to use |
|------|-------------------------------|------------------|-------------|
| `--mode selfhosted` | api-gateway **+ Postgres + Redis** | containers on the VM | Smallest footprint, demos, single-box prod |
| `--mode managed` | api-gateway **only** | **managed** RDS/ElastiCache or DO Managed DB/Redis | Real production — backups, HA, scaling handled by the cloud |

**Recommendation:** use `managed` for anything customer-facing so the database
has automated backups, failover and point-in-time recovery.

## 3. Database & migrations — there is no manual SQL

On every boot the gateway runs each SDK's migrations in dependency order
(forward-only, sha256-tracked in a migrations ledger table). Consequences:

- **First deploy:** point the gateway at an **empty** database; it creates the
  entire schema itself. Give it a generous health-check `start_period` (≥ 60s)
  for the first boot.
- **Upgrades:** deploy the new image and restart; new migrations apply
  automatically, already-applied ones are skipped.
- **Rollback:** migrations are forward-only. Roll back by restoring a database
  snapshot taken **before** the deploy — always snapshot the managed DB before
  a release.

The DB user the gateway connects as therefore needs DDL rights (CREATE
TABLE/INDEX/TYPE) on its database.

**Required extensions:** the cluster must have **pgvector** (sdk-agent-runtime)
and **PostGIS** (sdk-geo) available, or the gateway aborts on boot. The bundled
`scripts/setup/postgres.Dockerfile` bakes both in (used by the self-hosted
profile); for managed Postgres (RDS / DO) enable them via the provider's
extension mechanism. `prod-setup.sh --mode selfhosted` runs
`ensure-pg-extensions.sh` to verify/install them before the gateway starts.

## 4. Environment & secrets

Copy the template and fill it in on the host (never commit it):

```bash
cp scripts/setup/.env.prod.example .env.prod
```

Must-set before `prod-setup.sh` will start (it refuses on `CHANGE_ME`/empty):

| Variable | Notes |
|----------|-------|
| `DB_PASSWORD` | Managed DB password |
| `ADMIN_OPS_TOKEN` | Shared secret for `/admin/*` operator endpoints + seeding. `openssl rand -hex 32` |
| `JWT_SECRET` | Long random string. `openssl rand -hex 32` |

Key others: `DB_HOST`/`DB_PORT`/`DB_NAME`/`DB_USER`, `DB_SSL=true` for managed
Postgres, `REDIS_HOST`/`REDIS_PASSWORD`, `CORS_ORIGIN` (your app domain),
`GATEWAY_PORT`. Full list with comments is in `.env.prod.example`. In a mature
setup, inject these from the cloud's secret store (AWS Secrets Manager, DO
secrets, Vault) rather than a file on disk.

## 5. Deploy procedure (cloud-agnostic)

On the target Linux host, as the deploy user, from the repo root:

```bash
# 0. Provision DB/Redis + open the firewall  → see your cloud-specific doc
# 1. Configure
cp scripts/setup/.env.prod.example .env.prod && $EDITOR .env.prod
# 2. Bring up the stack (builds the image, starts containers, runs migrations,
#    waits for /health, seeds pricing catalogs + first tenant)
scripts/setup/prod-setup.sh --mode managed        # or --mode selfhosted
# 3. Verify
curl -fsS http://localhost:3000/health
```

Updates later:

```bash
git pull
docker compose --env-file .env.prod -f scripts/setup/docker-compose.prod.yml up -d --build
```

## 6. Seeding production data

`prod-setup.sh` runs `seed-dev-data.mjs` inside the gateway container after the
stack is healthy. It applies the **pricing catalogs** (left in `draft`) and
creates a first tenant. For production you typically:

1. Review the draft pricing catalogs, then promote with an sdk-meter
   `setCatalogStatus({ status: 'active' })` call.
2. Replace the default `dev-app` tenant with your real tenant(s) via
   `POST /admin/tenants` (header `x-admin-ops-token: $ADMIN_OPS_TOKEN`):

   ```bash
   curl -X POST http://localhost:3000/admin/tenants \
     -H "x-admin-ops-token: $ADMIN_OPS_TOKEN" -H 'content-type: application/json' \
     -d '{"app_id":"acme","display_name":"Acme Inc","region":"us-east-1","isolation_tier":"P"}'
   ```

## 7. Scaling out

- Run **N** api-gateway replicas behind the load balancer; they are stateless
  (Redis holds the shared route cache + soft-cap counter — set `REDIS_ENABLED=true`
  and a shared `REDIS_HOST`).
- Move usage events onto **Kafka** (`KAFKA_ENABLED=true`, `KAFKA_BROKERS=...`)
  and run `meter-collector` to drain the topic.
- Enable **ClickHouse** (`CLICKHOUSE_ENABLED=true`) for OLAP trace/telemetry
  rollups; otherwise traces mirror into Postgres.
- Multi-pool database topology (admin/app/evidence) and PgBouncer are covered in
  `docs/v3.1/SCALING-RUNBOOK.md`.

## 8. Production hardening checklist

- [ ] Managed Postgres with automated backups + PITR; `DB_SSL=true`.
- [ ] Snapshot the DB immediately **before** every deploy (migration rollback path).
- [ ] TLS terminated at the LB/reverse proxy; gateway port **not** public.
- [ ] Firewall: only the LB reaches `:3000`; only the gateway reaches DB/Redis.
- [ ] Strong `ADMIN_OPS_TOKEN`/`JWT_SECRET`/`DB_PASSWORD` from a secret store.
- [ ] `CORS_ORIGIN` pinned to your real front-end origin(s).
- [ ] `NODE_ENV=production` (synthetic vendor stubs refuse to run unless
      `ALLOW_SYNTHETIC_*=true`; wire real adapters via their env vars).
- [ ] Centralized logs/metrics: gateway logs JSON to stdout; Prometheus scrape +
      Grafana dashboard in `infrastructure/`.
- [ ] Health/uptime check hitting `GET /health`.

## 9. Health, logs, rollback

```bash
COMPOSE="docker compose --env-file .env.prod -f scripts/setup/docker-compose.prod.yml"
$COMPOSE ps
$COMPOSE logs -f api-gateway
$COMPOSE restart api-gateway
$COMPOSE down                # stop (keeps managed DB; keeps local volumes)
# Roll back: deploy the previous image tag AND restore the pre-deploy DB snapshot.
```
