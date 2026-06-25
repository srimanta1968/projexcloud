# Production Setup — DigitalOcean

Deploy ProjexCloud on DigitalOcean. Read
[production-overview.md](./production-overview.md) first — this guide only
covers the **DigitalOcean-specific manual steps**; the app bootstrap is the same
`scripts/setup/prod-setup.sh`.

Target architecture (recommended `managed` mode):

```
DO DNS ─▶ DO Load Balancer (HTTPS, Let's Encrypt) ─▶ Droplet (Docker: api-gateway)
                                                  ├─▶ Managed PostgreSQL
                                                  └─▶ Managed Redis
```

DigitalOcean has **no managed Kafka**. If you need the usage event stream, run a
Kafka container (`prod-setup.sh --kafka` + `KAFKA_ENABLED=true`) or use a
third-party broker. Most deployments leave `KAFKA_ENABLED=false`.

## 1. Managed databases (DO Control Panel → Databases)

### 1a. Managed PostgreSQL (required)
- Engine **PostgreSQL 16**, plan sized to load (start 2 GB / 1 vCPU).
- Create database `projexcloud_db` and a user `projex` (or use `doadmin`).
- DO **requires TLS** → gateway sets `DB_SSL=true`.
- **Trusted sources:** add your Droplet so only it can connect (DO's firewall
  for managed DBs). Note the **private** host/port from the connection details.
- Automated daily backups + PITR are on by default — keep them.

### 1b. Managed Redis (recommended)
- Redis 7. TLS + a generated password (→ `REDIS_PASSWORD`).
- Add the Droplet to the DB's **trusted sources**.
- Use the **private** connection host.

> Use the **VPC-private** endpoints for both so DB/Redis traffic never leaves
> DigitalOcean's network. Put the Droplet and databases in the **same region +
> VPC**.

## 2. Droplet

- Image: **Ubuntu 22.04 LTS**.
- Size: start **4 GB / 2 vCPU** (the image build compiles ~90 packages; for a
  smaller Droplet, build with GHCR/CI and pull instead — see §5).
- Enable **VPC networking** (same VPC as the databases) and **backups**.
- Add your SSH key.

Cloud Firewall (Networking → Firewalls), attached to the Droplet:
- inbound **443** from anywhere (to the Load Balancer),
- inbound **3000** **from the Load Balancer only** (or keep 3000 closed and let
  the LB reach it over the VPC),
- inbound **22** from your admin IP,
- outbound all.

Install Docker on the Droplet:

```bash
sudo apt-get update && sudo apt-get install -y git
curl -fsSL https://get.docker.com | sudo sh        # Docker Engine + compose plugin
sudo usermod -aG docker $USER                       # re-login to take effect
```

## 3. Deploy the app

```bash
git clone <your-projexcloud-repo-url> && cd ProjexCloud
cp scripts/setup/.env.prod.example .env.prod
$EDITOR .env.prod
```

Set in `.env.prod` (use the **private** managed endpoints):

```ini
DB_HOST=private-projexcloud-db-do-user-xxxx.b.db.ondigitalocean.com
DB_PORT=25060                       # DO managed PG uses 25060, not 5432
DB_NAME=projexcloud_db
DB_USER=projex
DB_PASSWORD=<managed pg password>
DB_SSL=true
REDIS_ENABLED=true
REDIS_HOST=private-projex-redis-do-user-xxxx.b.db.ondigitalocean.com
REDIS_PORT=25061                    # DO managed Redis port
REDIS_PASSWORD=<managed redis password>
KAFKA_ENABLED=false
ADMIN_OPS_TOKEN=<openssl rand -hex 32>
JWT_SECRET=<openssl rand -hex 32>
CORS_ORIGIN=https://app.yourdomain.com
GATEWAY_PORT=3000
```

> ⚠ DigitalOcean managed Postgres listens on **25060** and Redis on **25061** —
> not the defaults. Copy the exact host/port from the DB's "Connection details".

Bootstrap (api-gateway only; DB/Redis are managed):

```bash
scripts/setup/prod-setup.sh --mode managed
```

It builds the image, starts the gateway, runs all SDK migrations against the
managed Postgres, waits for `/health`, and seeds pricing catalogs + a first
tenant.

## 4. Load Balancer + TLS

**Option A — DigitalOcean Load Balancer (recommended):**
1. Create a **Load Balancer** in the same VPC/region; add the Droplet.
2. Forwarding rule: **HTTPS 443 → HTTP 3000** on the Droplet.
3. TLS: let DO manage a **Let's Encrypt** cert for `app.yourdomain.com` (needs
   the domain in DO DNS), or upload your own.
4. Health check: **HTTP, port 3000, path `/health`**.
5. DO DNS: point `app.yourdomain.com` at the Load Balancer.

**Option B — Nginx + certbot on the Droplet** (no LB): install Nginx, reverse
proxy `https://app.yourdomain.com` → `http://127.0.0.1:3000`, and
`certbot --nginx` for TLS. Keep port 3000 bound to localhost only.

## 5. (Optional) Build in CI / GHCR instead of on the Droplet

For a smaller Droplet, build the image in CI and pull it:

```bash
# CI (GitHub Actions, etc.):
docker build -f services/api-gateway/Dockerfile -t ghcr.io/<org>/projexcloud-api-gateway:$GIT_SHA .
docker push ghcr.io/<org>/projexcloud-api-gateway:$GIT_SHA
# Droplet: edit scripts/setup/docker-compose.prod.yml `image:` to the GHCR ref,
# set IMAGE_TAG=$GIT_SHA in .env.prod, then:
docker login ghcr.io
docker compose --env-file .env.prod -f scripts/setup/docker-compose.prod.yml up -d
```

## 6. DigitalOcean App Platform note

This guide uses a Droplet because ProjexCloud's image builds the whole
workspace and the gateway needs a persistent connection to managed DB/Redis —
which maps cleanly to a Droplet + Docker. App Platform can run the prebuilt
image (§5) as a service, but you must still attach the managed DB/Redis and set
the same env; the Droplet path is the supported reference.

## 7. Upgrades, backups, rollback

- **Before each deploy:** trigger a manual backup of the managed Postgres (or
  rely on the PITR window).
- **Deploy:** `git pull && scripts/setup/prod-setup.sh --mode managed` (or GHCR
  `pull && up -d`). New migrations apply automatically.
- **Rollback:** redeploy the previous image tag **and** restore the pre-deploy
  database backup — migrations are forward-only.

## 8. DigitalOcean-specific troubleshooting

| Symptom | Likely cause |
|---------|--------------|
| Gateway can't reach Postgres | Droplet not in the DB's **trusted sources**; wrong port (**25060**); used the public instead of private host |
| `DB_SSL`/certificate errors | `DB_SSL=true` missing — DO managed PG mandates TLS |
| Redis connection refused | Port **25061**, Droplet not in Redis trusted sources, or `REDIS_PASSWORD` wrong |
| LB target unhealthy | health check must be HTTP `:3000` `/health`; first-boot migrations need time — the compose `start_period` covers this, but set the LB's unhealthy threshold generously |
| Build killed (OOM) on a 2 GB Droplet | build in CI/GHCR and pull (§5), or resize the Droplet for the build |
| Need Kafka | DO has none — run `prod-setup.sh --kafka` with `KAFKA_ENABLED=true`, or point `KAFKA_BROKERS` at an external broker |
