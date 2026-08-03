#!/usr/bin/env bash
# =============================================================================
# Auto-seed GLOBAL reference / fixture data — runs on EVERY env (qa/staging/prod)
# =============================================================================
# The app has migration-only reference rows (federation, routing pools, taxonomy
# versions, trace, empi candidate links, ontology, …) that some endpoints require
# by FIXED id. Migrations create the TABLES; this script seeds the ROWS. Without
# it a fresh environment 404s on those endpoints (e.g. taxonomy "no active
# schema", trace/plan/route not found).
#
# Source of truth: tests/setup_scripts/*.sql (the same files the dev/test MCP
# applies before a run). Every seed is IDEMPOTENT (ON CONFLICT DO NOTHING), so
# re-running on each deploy/boot is safe.
#
# TENANT-SCOPED seeds are SKIPPED here: any file containing "{{cache:...}}" needs
# a live tenant_id/app_id that is resolved at RUNTIME (per-def, from the signup
# cache) — those are NOT global and must not be applied at deploy time.
#
# Run automatically (compose one-shot `db-seed` service, see docker-compose.prod.yml)
# or manually:
#   DB_HOST=... DB_PORT=... DB_NAME=... DB_USER=... DB_PASSWORD=... \
#   SEED_DIR=../../tests/setup_scripts ./seed-reference-data.sh
# =============================================================================
set -uo pipefail

SEED_DIR="${SEED_DIR:-/seeds}"                       # mount tests/setup_scripts here
DB_HOST="${DB_HOST:-postgres}"
DB_PORT="${DB_PORT:-5432}"
DB_NAME="${DB_NAME:-projexcloud_db}"
DB_USER="${DB_USER:-postgres}"
: "${DB_PASSWORD:?DB_PASSWORD must be set}"
export PGPASSWORD="$DB_PASSWORD"

if [ ! -d "$SEED_DIR" ]; then
  echo "[seed] no seed dir at $SEED_DIR — nothing to do"; exit 0
fi

applied=0; skipped=0; failed=0
for f in "$SEED_DIR"/*.sql; do
  [ -e "$f" ] || continue
  name="$(basename "$f")"
  # Skip tenant/runtime-scoped seeds (resolved per-def from the signup cache).
  if grep -q '{{cache:' "$f"; then
    echo "[seed] SKIP (tenant-scoped, resolved at runtime): $name"
    skipped=$((skipped+1)); continue
  fi
  echo "[seed] applying: $name"
  if psql -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" -d "$DB_NAME" \
       -v ON_ERROR_STOP=0 -q -f "$f"; then
    applied=$((applied+1))
  else
    echo "[seed] WARN: $name reported errors (continuing — idempotent)"
    failed=$((failed+1))
  fi
done

echo "[seed] done — applied=$applied skipped=$skipped with-warnings=$failed"
exit 0
