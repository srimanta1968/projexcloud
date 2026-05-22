#!/usr/bin/env bash
# Runs every k6 load test in series. Requires the api-gateway to be up.
# Usage: BASE=http://localhost:3000 TOKEN=<jwt> ./tests/load/run-all.sh

set -e
BASE="${BASE:-http://localhost:3000}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

run() {
  echo
  echo "=== Running $1 ==="
  k6 run -e BASE="$BASE" ${TOKEN:+-e TOKEN="$TOKEN"} "$SCRIPT_DIR/$1"
}

run meter-gate-p99.js
run pool-router-warm.js
[ -n "$TOKEN" ] && run audit-throughput.js || echo "Skipping audit-throughput.js (set TOKEN env to run)"

echo
echo "=== All load tests complete ==="
