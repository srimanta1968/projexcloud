#!/usr/bin/env bash
# ProjexCloud — production bootstrap for a single Linux host (EC2 / Droplet / any VM).
#
# Cloud-AGNOSTIC: it provisions the application stack with Docker Compose. Each
# cloud's MANUAL steps (creating the VM, managed Postgres/Redis, firewalls, TLS)
# are documented separately:
#   - docs/setup/production-overview.md      (shared concepts, env, scaling)
#   - docs/setup/production-aws-ec2.md       (AWS: EC2 + RDS + ElastiCache + MSK)
#   - docs/setup/production-digitalocean.md  (DigitalOcean: Droplet + Managed DB/Redis)
#
# Run this ON the target host, from the repo root, after .env.prod is filled in.
#
# Modes (--mode):
#   selfhosted  (default)  Postgres + Redis + api-gateway all in compose on this host.
#   managed                api-gateway only; DB_HOST/REDIS_HOST point at managed services
#                          (set DB_SSL=true). Use when you provisioned RDS/ElastiCache/DO DB.
#
# Usage:
#   scripts/setup/prod-setup.sh --mode selfhosted
#   scripts/setup/prod-setup.sh --mode managed
#   scripts/setup/prod-setup.sh --mode managed --kafka     # also start a Kafka broker
set -euo pipefail

MODE="selfhosted"; WITH_KAFKA=0
while [ $# -gt 0 ]; do
  case "$1" in
    --mode) MODE="$2"; shift 2 ;;
    --kafka) WITH_KAFKA=1; shift ;;
    -h|--help) grep '^#' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "Unknown arg: $1" >&2; exit 1 ;;
  esac
done
[ "$MODE" = "selfhosted" ] || [ "$MODE" = "managed" ] || { echo "--mode must be selfhosted|managed" >&2; exit 1; }

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$REPO_ROOT"
COMPOSE_FILE="scripts/setup/docker-compose.prod.yml"
ENV_FILE="$REPO_ROOT/.env.prod"
step() { printf '\n=== %s ===\n' "$1"; }
ok()   { printf '  OK  %s\n' "$1"; }

step 'Checking prerequisites'
command -v docker >/dev/null || { echo 'Docker not found. Install Docker Engine + compose plugin.' >&2; exit 1; }
docker compose version >/dev/null 2>&1 || { echo 'docker compose plugin not found.' >&2; exit 1; }
docker info >/dev/null 2>&1 || { echo 'Docker daemon not running.' >&2; exit 1; }
ok "Docker $(docker --version | awk '{print $3}' | tr -d ,)"

step 'Validating .env.prod'
if [ ! -f "$ENV_FILE" ]; then
  echo "Missing $ENV_FILE. Create it:" >&2
  echo "  cp scripts/setup/.env.prod.example .env.prod  && edit it" >&2
  exit 1
fi
# Fail fast on unfilled placeholders for the must-set secrets.
for key in DB_PASSWORD ADMIN_OPS_TOKEN JWT_SECRET; do
  val="$(grep -E "^${key}=" "$ENV_FILE" | head -1 | cut -d= -f2-)"
  if [ -z "$val" ] || printf '%s' "$val" | grep -q 'CHANGE_ME'; then
    echo "  $key is not set (still CHANGE_ME/empty) in .env.prod — refusing to start." >&2
    exit 1
  fi
done
ok 'Required secrets present'

# Compose profile selection.
PROFILE_ARGS=()
if [ "$MODE" = "selfhosted" ]; then
  PROFILE_ARGS+=(--profile selfhosted)
  ok 'Mode: self-hosted (Postgres + Redis + api-gateway on this host)'
else
  ok 'Mode: managed (api-gateway only; DB/Redis are external managed services)'
  echo '      Ensure DB_HOST/REDIS_HOST in .env.prod point at the managed endpoints and DB_SSL=true.'
fi
[ "$WITH_KAFKA" -eq 1 ] && ok 'Kafka requested (set KAFKA_ENABLED=true in .env.prod too)'

export ENV_FILE
COMPOSE=(docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" "${PROFILE_ARGS[@]}")

step 'Building the api-gateway image'
"${COMPOSE[@]}" build api-gateway
ok 'Image built (whole workspace compiled inside the image)'

if [ "$MODE" = "selfhosted" ]; then
  step 'Starting Postgres first + ensuring extensions (pgvector + PostGIS)'
  "${COMPOSE[@]}" up -d postgres
  # Wait for the DB to accept connections before the gateway tries to migrate.
  for i in $(seq 1 30); do
    if "${COMPOSE[@]}" exec -T postgres pg_isready -U "${DB_USER:-projex}" >/dev/null 2>&1; then break; fi
    sleep 2
  done
  # The image bakes in both extensions; this verifies (and self-heals if an
  # older image is reused). Exits non-zero -> aborts before the gateway boots.
  DB_PORT="$(grep -E '^DB_PORT=' "$ENV_FILE" | cut -d= -f2- || true)"; DB_PORT="${DB_PORT:-5432}"
  DB_USER="$(grep -E '^DB_USER=' "$ENV_FILE" | cut -d= -f2- || true)"; DB_USER="${DB_USER:-projex}" \
    DB_PORT="$DB_PORT" bash "$REPO_ROOT/scripts/setup/ensure-pg-extensions.sh" projexcloud_pg
  ok 'pgvector + PostGIS confirmed'
else
  step 'Managed mode — verify pgvector/PostGIS on your managed Postgres'
  echo '      RDS/DO managed Postgres: ensure the pgvector + postgis extensions are'
  echo '      enabled (RDS parameter group / `CREATE EXTENSION`). The gateway aborts'
  echo '      on boot if they are unavailable.'
fi

step 'Starting the stack'
"${COMPOSE[@]}" up -d
ok 'Containers started; api-gateway runs all SDK migrations on first boot'

step 'Waiting for gateway health'
GW_PORT="$(grep -E '^GATEWAY_PORT=' "$ENV_FILE" | cut -d= -f2- || true)"; GW_PORT="${GW_PORT:-3000}"
for i in $(seq 1 60); do
  if curl -fsS "http://localhost:${GW_PORT}/health" >/dev/null 2>&1; then
    ok "Gateway healthy at http://localhost:${GW_PORT}/health"
    HEALTHY=1; break
  fi
  sleep 3
done
if [ "${HEALTHY:-0}" != "1" ]; then
  echo '  !  Gateway did not report healthy in time. Check logs:' >&2
  echo "     ${COMPOSE[*]} logs -f api-gateway" >&2
  exit 2
fi

step 'Seeding baseline data (pricing catalogs + dev/first tenant)'
# Run the seeder inside the gateway container so it has the built workspace + DB env.
ADMIN_TOKEN="$(grep -E '^ADMIN_OPS_TOKEN=' "$ENV_FILE" | cut -d= -f2-)"
"${COMPOSE[@]}" exec -T \
  -e GATEWAY_URL="http://localhost:3000" \
  -e ADMIN_OPS_TOKEN="$ADMIN_TOKEN" \
  api-gateway node scripts/setup/seed-dev-data.mjs || \
  echo '  !  Seeding reported issues — re-run later: docker compose ... exec api-gateway node scripts/setup/seed-dev-data.mjs'

cat <<EOF

=== Production stack is up ===
  Health:   http://localhost:${GW_PORT}/health
  Logs:     ${COMPOSE[*]} logs -f api-gateway
  Stop:     ${COMPOSE[*]} down
  Update:   git pull && ${COMPOSE[*]} up -d --build

Next (per cloud doc): put a TLS-terminating load balancer / reverse proxy in
front of port ${GW_PORT}, restrict the security group/firewall, and point DNS
at it. See docs/setup/production-overview.md and your cloud-specific doc.
EOF
