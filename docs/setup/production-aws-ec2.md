# Production Setup — AWS (EC2)

Deploy ProjexCloud on AWS. Read [production-overview.md](./production-overview.md)
first — this guide only covers the **AWS-specific manual steps**; the app
bootstrap is the same `scripts/setup/prod-setup.sh`.

Target architecture (recommended `managed` mode):

```
Route 53 ─▶ ALB (HTTPS, ACM cert) ─▶ EC2 (Docker: api-gateway) ─▶ RDS PostgreSQL
                                                              └──▶ ElastiCache Redis
                                                  (optional) └──▶ MSK (Kafka)
```

## 1. Managed services to create (AWS Console or CLI)

### 1a. RDS for PostgreSQL (required)
- Engine **PostgreSQL 16**, instance e.g. `db.t4g.medium` (size to load).
- **Storage autoscaling on**, automated backups + **PITR** enabled.
- Create DB `projexcloud_db`, master user `projex`.
- **Encryption in transit required** → the gateway sets `DB_SSL=true`.
- Security group `sg-rds`: inbound **5432 only from `sg-ec2`** (below).
- The master user has DDL rights — the gateway creates all schema on first boot.

### 1b. ElastiCache for Redis (recommended)
- Redis 7, cluster-mode disabled is fine to start.
- Enable **AUTH token** (→ `REDIS_PASSWORD`) and in-transit encryption.
- Security group `sg-redis`: inbound **6379 only from `sg-ec2`**.

### 1c. Amazon MSK / Kafka (optional — only if `KAFKA_ENABLED=true`)
- Create an MSK cluster; note the bootstrap brokers → `KAFKA_BROKERS`.
- SG inbound 9092/9094 from `sg-ec2`. Skip entirely if you don't need the usage
  event stream (gateway uses its in-process emitter).

## 2. EC2 instance

- AMI: Amazon Linux 2023 (or Ubuntu 22.04), arch matching your build.
- Size: start `t3.large` / `t4g.large` (the image build compiles ~90 packages —
  give it ≥ 4 GB RAM, or build elsewhere and pull from ECR; see §5).
- Root volume ≥ 30 GB.
- Security group `sg-ec2`:
  - inbound **3000 from `sg-alb` only** (not the world),
  - inbound 22 from your admin IP,
  - outbound all.
- IAM role: attach if you'll read secrets from Secrets Manager / pull from ECR.

Install Docker + compose plugin + git:

```bash
sudo dnf update -y && sudo dnf install -y docker git    # Amazon Linux 2023
sudo systemctl enable --now docker
sudo usermod -aG docker ec2-user            # re-login to take effect
# compose plugin:
sudo mkdir -p /usr/libexec/docker/cli-plugins
sudo curl -SL https://github.com/docker/compose/releases/latest/download/docker-compose-linux-$(uname -m) \
  -o /usr/libexec/docker/cli-plugins/docker-compose && sudo chmod +x /usr/libexec/docker/cli-plugins/docker-compose
```

## 3. Deploy the app

```bash
git clone <your-projexcloud-repo-url> && cd ProjexCloud
cp scripts/setup/.env.prod.example .env.prod
$EDITOR .env.prod
```

Set in `.env.prod` (managed endpoints):

```ini
DB_HOST=projexcloud-db.xxxx.us-east-1.rds.amazonaws.com
DB_PORT=5432
DB_NAME=projexcloud_db
DB_USER=projex
DB_PASSWORD=<rds password>
DB_SSL=true
REDIS_ENABLED=true
REDIS_HOST=projex-redis.xxxx.cache.amazonaws.com
REDIS_PASSWORD=<elasticache auth token>
KAFKA_ENABLED=false              # or true + KAFKA_BROKERS=<msk brokers>
ADMIN_OPS_TOKEN=<openssl rand -hex 32>
JWT_SECRET=<openssl rand -hex 32>
CORS_ORIGIN=https://app.yourdomain.com
GATEWAY_PORT=3000
```

Bootstrap (api-gateway only; RDS/ElastiCache are external):

```bash
scripts/setup/prod-setup.sh --mode managed
```

This builds the image, starts the gateway, runs all SDK migrations against RDS,
waits for `/health`, and seeds pricing catalogs + a first tenant.

> Prefer not to compile on the instance? Build once in CI, push to **ECR**, and
> on the EC2 host set `IMAGE_TAG` + run `docker compose ... pull && up -d`
> instead of `--build`. See §5.

## 4. Application Load Balancer + TLS

1. Request/import an **ACM certificate** for `app.yourdomain.com`.
2. Create an **ALB** (internet-facing) in public subnets, SG `sg-alb`
   (inbound 443 from the world).
3. Target group → EC2 instance, **port 3000**, health-check path **`/health`**
   (expects HTTP 200).
4. HTTPS:443 listener → target group; HTTP:80 → redirect to 443.
5. **Route 53**: `app.yourdomain.com` → ALB alias.

Now traffic flows `https://app.yourdomain.com` → ALB (TLS) → EC2:3000. The
gateway port is never exposed publicly.

## 5. (Optional) Build in CI, run from ECR

```bash
# CI:
aws ecr create-repository --repository-name projexcloud/api-gateway
docker build -f services/api-gateway/Dockerfile -t <acct>.dkr.ecr.<region>.amazonaws.com/projexcloud/api-gateway:$GIT_SHA .
docker push <acct>.dkr.ecr.<region>.amazonaws.com/projexcloud/api-gateway:$GIT_SHA
# EC2 .env.prod:  IMAGE_TAG=$GIT_SHA  (and edit docker-compose.prod.yml `image:` to the ECR repo,
#                 or pull+tag locally). Then:
docker compose --env-file .env.prod -f scripts/setup/docker-compose.prod.yml up -d
```

This keeps the EC2 box small and makes deploys a fast `pull && up -d`.

## 6. Real AWS adapters (optional)

The gateway wires real vendor adapters when their env is present (otherwise
synthetic stubs, which refuse to run under `NODE_ENV=production` unless
`ALLOW_SYNTHETIC_*=true`). Common ones:

```ini
AWS_REGION=us-east-1
S3_BUCKET=projexcloud-media          # sdk-media S3 signer
# SES for email, etc. Prefer an IAM instance role over static keys.
```

## 7. Upgrades, backups, rollback

- **Before each deploy:** take an RDS snapshot (manual or rely on PITR window).
- **Deploy:** `git pull && scripts/setup/prod-setup.sh --mode managed`
  (or ECR `pull && up -d`). New migrations apply automatically.
- **Rollback:** redeploy the previous image tag **and** restore the pre-deploy
  RDS snapshot — migrations are forward-only.

## 8. AWS-specific troubleshooting

| Symptom | Likely cause |
|---------|--------------|
| Gateway can't reach RDS | `sg-rds` doesn't allow 5432 from `sg-ec2`; or wrong `DB_HOST` |
| TLS handshake / `no pg_hba` errors | `DB_SSL=true` missing, or RDS "require SSL" parameter |
| ALB target unhealthy | health-check path must be `/health`, port 3000; `start_period` too short for first-boot migrations |
| Redis timeouts | `sg-redis` 6379 from `sg-ec2`; AUTH token mismatch (`REDIS_PASSWORD`) |
| OOM during `--build` | instance too small — use a bigger instance for the build or build in CI/ECR (§5) |
