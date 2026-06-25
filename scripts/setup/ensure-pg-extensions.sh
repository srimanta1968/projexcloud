#!/usr/bin/env bash
# Ensure the Postgres cluster behind the app has the extensions ProjexCloud
# requires: pgvector (sdk-agent-runtime vector namespaces) and PostGIS (sdk-geo).
#
# The api-gateway runs every SDK migration on boot and ABORTS if either
# extension is unavailable (e.g. `extension "vector" is not available`,
# `sdk-geo requires PostGIS`). This script makes the dev/prod setup self-healing:
# it inspects the running Postgres container, installs whatever is missing via
# the pgdg apt repo (version-matched), verifies, and EXITS NON-ZERO if it cannot
# — so the caller stops before a doomed gateway boot.
#
# Usage:
#   scripts/setup/ensure-pg-extensions.sh [CONTAINER_NAME]
# Env:
#   DB_PORT  host port the app connects to (default 5432) — used to auto-detect
#            the container when CONTAINER_NAME is not given.
set -euo pipefail

REQUIRED_EXTS="vector postgis"
CONTAINER="${1:-}"
DB_PORT="${DB_PORT:-5432}"
note() { printf '  [pg-ext] %s\n' "$1"; }

command -v docker >/dev/null || { echo "  [pg-ext] docker not found." >&2; exit 1; }

# 1. Resolve the container publishing DB_PORT (unless one was passed).
if [ -z "$CONTAINER" ]; then
  CONTAINER="$(docker ps --format '{{.Names}}\t{{.Ports}}' \
    | awk -v p=":${DB_PORT}->" 'index($0,p){print $1; exit}')"
fi
if [ -z "$CONTAINER" ]; then
  echo "  [pg-ext] No running Postgres container found publishing :${DB_PORT}." >&2
  echo "  [pg-ext] Start Postgres first, or pass the container name explicitly." >&2
  exit 1
fi
note "target container: $CONTAINER (port $DB_PORT)"

psqlc() { docker exec "$CONTAINER" psql -U "${DB_USER:-postgres}" -d postgres -tAc "$1" 2>/dev/null; }

# 2. Confirm it is actually Postgres and reachable.
PG_VERNUM="$(psqlc 'SHOW server_version_num;' || true)"
if [ -z "$PG_VERNUM" ]; then
  echo "  [pg-ext] Could not query Postgres in '$CONTAINER' (is it ready / is DB_USER right?)." >&2
  exit 1
fi
PG_MAJOR=$(( PG_VERNUM / 10000 ))
note "Postgres major version: $PG_MAJOR"

# 3. Per extension: available? if not, install the pgdg package for this major.
pkg_for() {
  case "$1" in
    vector)  echo "postgresql-${PG_MAJOR}-pgvector" ;;
    postgis) echo "postgresql-${PG_MAJOR}-postgis-3" ;;
    *) echo "" ;;
  esac
}

installed_any=0
for ext in $REQUIRED_EXTS; do
  if [ -n "$(psqlc "SELECT 1 FROM pg_available_extensions WHERE name='${ext}';")" ]; then
    note "$ext: already available ✓"
    continue
  fi
  pkg="$(pkg_for "$ext")"
  note "$ext: NOT available — installing $pkg ..."
  if ! docker exec "$CONTAINER" sh -c "command -v apt-get >/dev/null"; then
    echo "  [pg-ext] '$CONTAINER' has no apt-get (non-Debian image). Use a Postgres" >&2
    echo "  [pg-ext] image that bundles $ext (e.g. postgis/postgis + pgvector). Aborting." >&2
    exit 1
  fi
  if ! docker exec "$CONTAINER" sh -c "apt-get update -qq && apt-get install -y -qq $pkg" >/dev/null 2>&1; then
    echo "  [pg-ext] Failed to install $pkg in '$CONTAINER' (network? wrong PG major?). Aborting." >&2
    exit 1
  fi
  # Re-verify availability after install.
  if [ -z "$(psqlc "SELECT 1 FROM pg_available_extensions WHERE name='${ext}';")" ]; then
    echo "  [pg-ext] $pkg installed but '$ext' still not available. Aborting." >&2
    exit 1
  fi
  note "$ext: installed ✓"
  installed_any=1
done

[ "$installed_any" -eq 1 ] && note "extensions added — no restart needed (CREATE EXTENSION runs in migrations)."
note "all required extensions present: $REQUIRED_EXTS"
