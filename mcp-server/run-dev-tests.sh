#!/bin/bash
#===============================================================================
# ProjexLight DEV MCP Test Runner
#===============================================================================
# Runs API tests through the DEV MCP, using tests/api_definitions on disk as the
# source of truth.
#
# This is the sibling of run-all-tests.sh, and the difference matters:
#   run-all-tests.sh  -> TEST MCP,  reads definitions from the api_library table
#   run-dev-tests.sh  -> DEV  MCP,  reads definitions from tests/api_definitions
#
# So this script is what you use to verify a definition you just edited, BEFORE
# it has been published to the library.
#
# Usage:
#   ./run-dev-tests.sh                          - full run, producer dataset only
#   ./run-dev-tests.sh --datasets all           - run EVERY dataset per definition
#   ./run-dev-tests.sh --mode incremental       - only APIs affected by changed files
#   ./run-dev-tests.sh --project-path /projects/additional1
#   ./run-dev-tests.sh --status                 - show current run status
#   ./run-dev-tests.sh --clear                  - clear the stored result
#
# Options:
#   --datasets first|all   Which datasets to execute (default: first)
#                          first = only the PRODUCER dataset per definition, i.e.
#                                  the one allowed to populate the {{cache:...}}
#                                  values. This is the historical behaviour.
#                          all   = additionally run every other dataset, with
#                                  capture disabled so a passing negative case
#                                  can never displace a cached id or token.
#   --mode  full|incremental  Test all definitions, or only those affected by
#                             changed files (default: full)
#   --project-path PATH    Path AS SEEN BY THE CONTAINER, not the host.
#                          The primary project is /workspace; additional mounts
#                          are /projects/additional1, 2, ... (default: /workspace)
#   --port PORT            Dev MCP port (default: 8766, or $MCP_DEV_PORT)
#   --timeout SECONDS      How long to wait for completion (default: 1800)
#
# Note on --datasets all: it is deliberately NOT the default. A definition can
# carry several datasets, so this multiplies request volume — LeadFlow goes from
# 47 requests to 179, ProjexCloud from 694 to 827. Keep the pre-push gate on
# 'first' and use 'all' when you want the full matrix.
#===============================================================================

set -euo pipefail

DEV_PORT="${MCP_DEV_PORT:-8766}"
PROJECT_PATH="/workspace"
DATASETS="first"
MODE="full"
TIMEOUT=1800
ACTION="run"

GREEN='\033[0;32m'; YELLOW='\033[1;33m'; RED='\033[0;31m'; BLUE='\033[0;34m'; NC='\033[0m'
say() { echo -e "${1}${2}${NC}"; }

while [[ $# -gt 0 ]]; do
    case "$1" in
        --datasets)     DATASETS="${2:-first}"; shift 2 ;;
        --mode)         MODE="${2:-full}"; shift 2 ;;
        --project-path) PROJECT_PATH="${2:-/workspace}"; shift 2 ;;
        --port)         DEV_PORT="${2:-8766}"; shift 2 ;;
        --timeout)      TIMEOUT="${2:-1800}"; shift 2 ;;
        --status)       ACTION="status"; shift ;;
        --clear)        ACTION="clear"; shift ;;
        -h|--help)      sed -n '2,45p' "$0"; exit 0 ;;
        *) say "$RED" "[ERROR] Unknown option: $1"; exit 1 ;;
    esac
done

case "$DATASETS" in first|all) ;; *) say "$RED" "[ERROR] --datasets must be 'first' or 'all'"; exit 1 ;; esac
case "$MODE" in full|incremental) ;; *) say "$RED" "[ERROR] --mode must be 'full' or 'incremental'"; exit 1 ;; esac

BASE="http://localhost:${DEV_PORT}"

if ! curl -sf --max-time 10 "${BASE}/health" >/dev/null 2>&1; then
    say "$RED" "[ERROR] Dev MCP is not answering on ${BASE}"
    echo "  The container can report healthy while the published port is not yet"
    echo "  serving. Check with:  docker ps --filter name=dev-mcp"
    echo "  and restart if needed: docker restart projexlight-dev-mcp"
    exit 1
fi

summarize() {
    # The raw status payload embeds every request/response body — several MB on a
    # full run. Print the summary and the failing datasets; the whole document is
    # on disk for anything deeper.
    python -c '
import sys, json
try: d = json.load(sys.stdin)
except Exception: print("(no parsable status)"); raise SystemExit(0)
print("status:", d.get("status"), "| run:", d.get("testRunId"))
r = d.get("result") or {}
s = r.get("summary") or {}
if s:
    print("  APIs      : %s total, %s passed, %s failed, %s skipped"
          % (s.get("totalAPIs"), s.get("passedAPIs"), s.get("failedAPIs"), s.get("skippedAPIs")))
    print("  Duration  : %ss" % round((s.get("testDurationMs") or 0)/1000, 1))
ds = [t for t in (r.get("newAPIsTested") or []) if t.get("datasets")]
if ds:
    tot = sum(t.get("datasetsTotal", 0) for t in ds)
    ok  = sum(t.get("datasetsPassed", 0) for t in ds)
    print("  Datasets  : %s/%s passed across %s definitions" % (ok, tot, len(ds)))
    for t in ds:
        bad = [x for x in t["datasets"] if x.get("status") != "passed"]
        if bad:
            print("    %s %s" % (t.get("method"), t.get("endpoint")))
            for b in bad:
                print("       [%s] %s | expected %s got %s%s"
                      % (b.get("index"), (b.get("name") or "")[:52], b.get("expectedStatus"),
                         b.get("actualStatus"), "  <-- PRODUCER" if b.get("isProducer") else ""))
' 2>/dev/null || echo "(python unavailable — use --raw)"
}

if [[ "$ACTION" == "status" ]]; then
    curl -s --max-time 60 "${BASE}/api/test/status?projectPath=${PROJECT_PATH}" | summarize; exit 0
fi
if [[ "$ACTION" == "clear" ]]; then
    curl -s -X POST --max-time 30 "${BASE}/api/test/clear?projectPath=${PROJECT_PATH}"; echo; exit 0
fi

say "$BLUE" "═══════════════════════════════════════════════════════════════"
say "$BLUE" "   ProjexLight DEV MCP - API Tests"
say "$BLUE" "═══════════════════════════════════════════════════════════════"
echo "  Project path : ${PROJECT_PATH}"
echo "  Mode         : ${MODE}"
echo "  Datasets     : ${DATASETS}"
echo "  Dev MCP      : ${BASE}"
echo ""

START_PAYLOAD=$(printf '{"api_test_mode":"%s","datasets":"%s","projectPath":"%s"}' "$MODE" "$DATASETS" "$PROJECT_PATH")
RESP=$(curl -s -X POST --max-time 60 -H 'Content-Type: application/json' -d "$START_PAYLOAD" "${BASE}/api/test/start")
echo "$RESP" | grep -q '"status"' || { say "$RED" "[ERROR] Failed to start tests"; echo "$RESP"; exit 1; }
say "$GREEN" "[OK] Tests started"

# Poll. The run is asynchronous on purpose: a synchronous call can exceed the
# server-side timeout, and the timeout path used to crash before reporting.
DEADLINE=$(( SECONDS + TIMEOUT ))
LAST=""
while (( SECONDS < DEADLINE )); do
    STATUS_JSON=$(curl -s --max-time 60 "${BASE}/api/test/status?projectPath=${PROJECT_PATH}" 2>/dev/null || echo '{}')
    # Parse the TOP-LEVEL status with a real JSON parser. A regex cannot do this:
    # the payload is one line of several MB and every per-test result carries its
    # own "status", so a greedy match returns the LAST one ("passed") and the
    # loop never terminates — it polls until the timeout on an already-finished run.
    STATE=$(printf '%s' "$STATUS_JSON" | python -c 'import sys,json
try: print((json.load(sys.stdin) or {}).get("status") or "unknown")
except Exception: print("unknown")' 2>/dev/null || echo unknown)
    if [[ "$STATE" != "$LAST" ]]; then say "$YELLOW" "  [$(date +%H:%M:%S)] ${STATE}"; LAST="$STATE"; fi
    case "$STATE" in
        completed|idle)
            say "$GREEN" "[DONE] Run finished"
            echo "$STATUS_JSON" > "./dev-test-result.json" 2>/dev/null || true
            echo ""
            echo "$STATUS_JSON" | summarize
            echo ""
            echo "  Full result written to ./dev-test-result.json"
            echo "  HTML report + per-dataset detail: test-results/"
            echo "  Failures for the fix-sticky:      test-results/feedback/api-test-failures.json"
            exit 0 ;;
    esac
    sleep 15
done

say "$RED" "[TIMEOUT] Still running after ${TIMEOUT}s — it may yet finish."
echo "  Check with: $0 --status --project-path ${PROJECT_PATH}"
exit 2
