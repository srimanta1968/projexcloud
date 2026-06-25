#!/usr/bin/env bash
# One-shot developer environment bootstrap for ProjexCloud (Linux / macOS / WSL / Git Bash).
#
# Replaces the old dev container. Brings a clean checkout to a runnable state:
#   1. Verifies prerequisites (Node 20+, Docker, corepack/pnpm).
#   2. Creates .env from .env.example if missing (+ a dev ADMIN_OPS_TOKEN).
#   3. Starts the Postgres container (docker compose up -d postgres).
#   4. Installs workspace deps (pnpm install) and builds (pnpm -w build).
#   5. Optionally (--seed) starts the api-gateway and seeds baseline data.
#
# The api-gateway auto-runs every SDK migration on first boot — no manual SQL.
# See docs/setup/dev-environment.md.
#
# Usage:  scripts/setup/dev-setup.sh [--skip-build] [--seed]
set -euo pipefail

SKIP_BUILD=0; SEED=0; FULL=0
for a in "$@"; do
  case "$a" in
    --skip-build) SKIP_BUILD=1 ;;
    --seed) SEED=1 ;;
    --full) FULL=1 ;;
    -h|--help) grep '^#' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "Unknown arg: $a" >&2; exit 1 ;;
  esac
done

# set_env KEY VALUE — idempotently set a key in the repo-root .env.
set_env() {
  local k="$1" v="$2"
  [ -f .env ] || return 0
  if grep -qE "^${k}=" .env; then grep -vE "^${k}=" .env > .env.tmp && mv .env.tmp .env; fi
  printf '%s=%s\n' "$k" "$v" >> .env
}

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$REPO_ROOT"
step() { printf '\n=== %s ===\n' "$1"; }
ok()   { printf '  OK  %s\n' "$1"; }
warn() { printf '  !   %s\n' "$1"; }

step 'Checking prerequisites'
command -v node >/dev/null || { echo 'Node.js not found. Install Node 20 LTS.' >&2; exit 1; }
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
[ "$NODE_MAJOR" -ge 20 ] || { echo "Node $(node -v) found; ProjexCloud requires Node 20+." >&2; exit 1; }
ok "Node $(node -v)"
command -v docker >/dev/null || { echo 'Docker not found. Install Docker.' >&2; exit 1; }
docker info >/dev/null 2>&1 || { echo 'Docker is not running. Start the daemon and re-run.' >&2; exit 1; }
ok 'Docker is running'
# corepack writes a pnpm shim under the Node dir; on Windows that needs admin and
# emits a benign EPERM. pnpm still resolves, so suppress noise and keep going.
corepack enable >/dev/null 2>&1 || true
command -v pnpm >/dev/null || { echo 'pnpm not available. Run: npm i -g pnpm@9' >&2; exit 1; }
ok "pnpm $(pnpm --version)"

step 'Environment file (.env)'
if [ ! -f .env ]; then
  cp .env.example .env
  ok 'Created .env from .env.example'
  TOKEN="$(node -e 'console.log(require("crypto").randomBytes(24).toString("hex"))')"
  { printf '\nADMIN_OPS_TOKEN=%s\n' "$TOKEN"; printf 'KAFKA_ENABLED=false\n'; } >> .env
  ok 'Added dev ADMIN_OPS_TOKEN and KAFKA_ENABLED=false'
else
  warn '.env already exists — leaving it untouched'
fi

step 'Starting Postgres (docker compose)'
DB_PORT="$(grep -E '^DB_PORT=' .env | head -1 | cut -d= -f2- | tr -d '[:space:]')"; DB_PORT="${DB_PORT:-5432}"
if node -e "require('net').connect({host:'localhost',port:$DB_PORT},()=>process.exit(0)).on('error',()=>process.exit(1))" 2>/dev/null; then
  warn "Postgres already reachable on :$DB_PORT — using it, skipping 'docker compose up -d postgres'"
else
  docker compose up -d postgres
  docker compose ps postgres
  ok 'Postgres container started (data persists in the postgres_data volume)'
fi

step 'Ensuring required Postgres extensions (pgvector + PostGIS)'
# The gateway aborts on boot if pgvector/PostGIS are missing. Auto-install them
# into the running Postgres container; this exits non-zero (and aborts setup via
# `set -e`) if it cannot, so we never proceed to a doomed gateway boot.
DB_PORT="$DB_PORT" bash "$REPO_ROOT/scripts/setup/ensure-pg-extensions.sh"
ok 'pgvector + PostGIS available'

step 'Starting infra containers (Redis; + Kafka/ClickHouse with --full)'
# `pnpm dev` runs every service as a Node process. Redis is needed by the
# gateway cache and the identity-projector; Kafka + ClickHouse by the
# meter-collector. Bring up the infra these connect to and flip the env flags.
docker compose up -d redis
set_env REDIS_ENABLED true
ok 'Redis up (REDIS_ENABLED=true)'
if [ "$FULL" -eq 1 ]; then
  docker compose --profile full up -d kafka clickhouse
  set_env KAFKA_ENABLED true
  set_env CLICKHOUSE_ENABLED true
  ok 'Kafka + ClickHouse up (KAFKA_ENABLED=true, CLICKHOUSE_ENABLED=true)'
else
  # No Kafka/ClickHouse containers: make the meter-collector degrade cleanly
  # (in-process usage buffer + Postgres ledger only). Both default-ON in that
  # worker, so they must be explicitly disabled.
  set_env KAFKA_ENABLED false
  set_env CLICKHOUSE_ENABLED false
  warn 'Kafka/ClickHouse not started (KAFKA_ENABLED=false, CLICKHOUSE_ENABLED=false).'
  warn 'meter-collector falls back to the Postgres usage ledger. Re-run with --full for the OLAP tier.'
fi

step 'Installing workspace dependencies (pnpm install)'
pnpm install
ok 'Dependencies installed'

if [ "$SKIP_BUILD" -eq 0 ]; then
  step 'Building the workspace (pnpm -w build)'
  pnpm -w build
  ok 'Build complete'
else
  warn 'Skipping build (--skip-build)'
fi

GW_PORT="$(grep -E '^PORT=' .env | head -1 | cut -d= -f2- | tr -d '[:space:]')"; GW_PORT="${GW_PORT:-3000}"
GW_URL="http://localhost:${GW_PORT}"
if [ "$SEED" -eq 1 ]; then
  step 'Starting api-gateway (background) + seeding'
  pnpm --filter @projexlight/api-gateway dev &
  GW_PID=$!
  ok "api-gateway started (PID $GW_PID) on ${GW_URL}; migrations run on boot"
  # seed-dev-data waits for /health itself.
  set +e
  node "$REPO_ROOT/scripts/setup/seed-dev-data.mjs" --gateway "$GW_URL"
  set -e
  warn "Gateway still running in the background (PID $GW_PID). Stop with: kill $GW_PID"
else
  step 'Next steps'
  cat <<EOF
  Start the API gateway (runs migrations on boot):
      pnpm --filter @projexlight/api-gateway dev
  Then in a second terminal, seed baseline data:
      node scripts/setup/seed-dev-data.mjs --gateway ${GW_URL}
  Health check:
      curl ${GW_URL}/health
  Admin portals (optional):
      pnpm --filter @projexlight/projexcloud-admin dev   # http://localhost:3100
      pnpm --filter @projexlight/tenant-admin dev        # http://localhost:3200
EOF
fi
printf '\nDev environment ready.\n'
