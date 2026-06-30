#!/usr/bin/env bash
#
# Canonical ProjexCloud prod deploy / reconcile. Single source of truth for the
# multi-file Compose invocation — used by manual deploys AND the
# projexcloud.service systemd unit on boot, so the exact same file set + profiles
# are always applied (no more "someone ran a plain `compose up` and lost an
# override" footgun).
#
# Project names are baked into the compose files (`name: projexcloud-prod` /
# `name: projexcloud-portals`), so this reconciles the EXISTING stacks — it never
# spawns duplicates.
#
# Usage:
#   ./deploy.sh up        reconcile to desired state using current images (no build)
#   ./deploy.sh pull      pull newer images from the registry (when IMAGE_PREFIX/TAG set)
#   ./deploy.sh deploy    pull then up  (registry-based deploy)
#   ./deploy.sh ps        show status
#   ./deploy.sh logs <svc>
#
set -euo pipefail
cd "$(dirname "$0")"

ENV_FILE=".env.prod"

# Main stack: match the running `projexcloud-prod` project exactly.
MAIN_FILES=(-f scripts/setup/docker-compose.prod.yml -f scripts/setup/docker-compose.clickhouse.yml)
# local-artifacts is a server-only (untracked) override that bind-mounts the
# sdk-registry artifacts the discovery container needs. Include it iff present.
if [ -f scripts/setup/docker-compose.local-artifacts.yml ]; then
  MAIN_FILES+=(-f scripts/setup/docker-compose.local-artifacts.yml)
fi
# NOTE: docker-compose.db-expose.yml is intentionally NOT included — it publishes
# Postgres 5432 to the host for pgAdmin and is applied on-demand only, not part of
# the steady-state stack.
PROFILES=(--profile selfhosted --profile discovery)

PORTAL_ENV="scripts/setup/.env"
PORTAL_FILES=(-f scripts/setup/docker-compose.portals.yml)

main_compose() { docker compose --env-file "$ENV_FILE" "${MAIN_FILES[@]}" "${PROFILES[@]}" "$@"; }
portal_compose() { docker compose --env-file "$PORTAL_ENV" "${PORTAL_FILES[@]}" "$@"; }

cmd="${1:-up}"
case "$cmd" in
  up)
    # --no-build: never build on this path (esp. on boot). Uses existing images;
    # reconciles config + (re)starts anything not already running. Idempotent.
    main_compose up -d --no-build
    portal_compose up -d --no-build
    echo "[deploy] reconcile complete"
    ;;
  pull)
    main_compose pull
    portal_compose pull
    ;;
  deploy)
    "$0" pull
    main_compose up -d --no-build
    portal_compose up -d --no-build
    echo "[deploy] registry deploy complete"
    ;;
  ps)
    main_compose ps
    portal_compose ps
    ;;
  logs)
    shift
    main_compose logs --tail=100 -f "$@"
    ;;
  *)
    echo "usage: $0 {up|pull|deploy|ps|logs <svc>}" >&2
    exit 1
    ;;
esac
