#!/usr/bin/env bash
#
# Incremental prod redeploy of one or more services.
#
# Rebuilds ONLY the named service image(s) — the Dockerfiles use BuildKit cache
# mounts (see commit "perf(docker): incremental image builds"), so an unchanged
# workspace recompiles in seconds — then recreates just those containers. It
# reconciles the EXISTING `projexcloud-prod` / `projexcloud-portals` compose
# projects, so it never spawns duplicate stacks.
#
# This replaces the ad-hoc, untracked ~/deploy-*.sh scripts that previously
# lived only on the EC2 box (and would vanish with it).
#
# Usage (run ON the prod host, from the repo root, with .env.prod filled in):
#   scripts/setup/deploy-service.sh api-gateway
#   scripts/setup/deploy-service.sh api-gateway portal-console
#   NO_PULL=1 scripts/setup/deploy-service.sh api-gateway   # skip the git pull
#
# Recognised services:
#   main stack (projexcloud-prod):  api-gateway, postgres, redis, clickhouse,
#                                   registry-mcp  (anything not a portal)
#   portals   (projexcloud-portals): portal-workspace, portal-tenant, portal-console
set -euo pipefail
cd "$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

[ $# -ge 1 ] || { echo "usage: $0 <service> [service...]" >&2; exit 1; }

# BuildKit is what makes the per-service rebuild incremental (cache mounts).
export DOCKER_BUILDKIT=1 COMPOSE_DOCKER_CLI_BUILD=1

# --- main stack (projexcloud-prod): gateway + infra --------------------------
# Mirror deploy.sh's file set + profiles exactly so we reconcile the running
# project rather than diverging from it.
MAIN_FILES=(-f scripts/setup/docker-compose.prod.yml -f scripts/setup/docker-compose.clickhouse.yml)
# Server-only (untracked) override that bind-mounts sdk-registry artifacts the
# discovery container needs. Include iff present — matches deploy.sh.
[ -f scripts/setup/docker-compose.local-artifacts.yml ] && MAIN_FILES+=(-f scripts/setup/docker-compose.local-artifacts.yml)
MAIN_PROFILES=(--profile selfhosted --profile discovery)
main_compose() { docker compose --env-file .env.prod "${MAIN_FILES[@]}" "${MAIN_PROFILES[@]}" "$@"; }

# --- portals stack (projexcloud-portals) -------------------------------------
portal_compose() { docker compose --env-file scripts/setup/.env -f scripts/setup/docker-compose.portals.yml "$@"; }

is_portal() {
  case "$1" in
    portal-workspace|portal-tenant|portal-console) return 0 ;;
    *) return 1 ;;
  esac
}

# Refresh source first (default on; set NO_PULL=1 to deploy the current checkout).
if [ "${NO_PULL:-0}" != "1" ]; then
  echo "== git pull main =="
  git fetch origin main
  git checkout main
  git pull --ff-only origin main
fi

for svc in "$@"; do
  if is_portal "$svc"; then compose() { portal_compose "$@"; }; else compose() { main_compose "$@"; }; fi
  echo "== build $svc =="
  compose build "$svc"
  echo "== up -d $svc (recreate container) =="
  compose up -d "$svc"
done

# Health-gate the gateway when it was among the targets.
for svc in "$@"; do
  if [ "$svc" = "api-gateway" ]; then
    echo "== waiting for gateway /health =="
    for _ in $(seq 1 40); do
      if curl -fsS http://localhost:3000/health >/dev/null 2>&1; then echo "GATEWAY_HEALTHY"; break; fi
      sleep 3
    done
  fi
done

echo "== status =="
docker ps --format '{{.Names}}\t{{.Status}}' | grep -E 'gateway|portal' || true
echo "DEPLOY_SERVICE_DONE"
