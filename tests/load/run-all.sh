#!/usr/bin/env bash
# Runs every k6 load + Node seeder/scale harness in tests/load/.
# Requires the api-gateway to be up.
#
# Usage:  BASE=http://localhost:3000 TOKEN=<jwt> ./tests/load/run-all.sh
#
# AC matrix:
#   AC-5/8  pool-router-warm.js  +  meter-gate-p99.js   (P1, k6)
#   AC-9    rebac-traversal.js   (P2 ReBAC 10M-edge load — needs seeder first)
#   AC-14   projection-refresh.js (P2 projection refresh latency, 1000 trials)
#   AC-15   projection-scale.js   (P2 50GB Postgres + 10GB Redis budget)

set -e
BASE="${BASE:-http://localhost:3000}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

run_k6() {
  echo
  echo "=== k6: $1 ==="
  k6 run -e BASE="$BASE" ${TOKEN:+-e TOKEN="$TOKEN"} "$SCRIPT_DIR/$1"
}

run_node() {
  echo
  echo "=== node: $1 ==="
  node "$SCRIPT_DIR/$1"
}

# --- P1 load (no auth required) ---
run_k6 meter-gate-p99.js
run_k6 pool-router-warm.js

# --- P1 audit throughput (auth required) ---
if [ -n "$TOKEN" ]; then
  run_k6 audit-throughput.js
else
  echo "Skipping audit-throughput.js (set TOKEN env to run)"
fi

# --- P2 ReBAC (AC-9): seed first, then load ---
if [ -n "$TOKEN" ]; then
  if [ ! -f "$SCRIPT_DIR/personas.json" ]; then
    run_node seed-rebac.js
  else
    echo "Reusing existing personas.json (delete to re-seed)"
  fi
  run_k6 rebac-traversal.js
else
  echo "Skipping ReBAC load (set TOKEN env to run)"
fi

# --- P2 projection refresh (AC-14): auth required ---
if [ -n "$TOKEN" ]; then
  run_k6 projection-refresh.js
else
  echo "Skipping projection-refresh.js (set TOKEN env to run)"
fi

# --- P2 projection scale (AC-15): direct DB, no API auth ---
run_node projection-scale.js

echo
echo "=== All load tests complete ==="
