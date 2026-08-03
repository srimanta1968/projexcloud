#!/usr/bin/env bash
#===============================================================================
# apply-qa-seeds.sh — apply the idempotent QA fixture seeds to a deployed stack
#===============================================================================
#
# WHY THIS EXISTS
# ---------------
# tests/setup_scripts/ holds two kinds of setup:
#
#   *.py / *.js  — API-based. The Test MCP runs these automatically before every
#                  API run (api_test_runner.py:_run_setup_scripts). They work
#                  against ANY target, local or remote, because they only need
#                  the SUT's HTTP surface.
#
#   *.sql        — direct-database. The Test MCP explicitly SKIPS these
#                  ("*.sql is ignored — those are handled elsewhere",
#                  api_test_runner.py:1283). Nothing else ran them either, so on
#                  a deployed stack they had simply never been applied.
#
# The visible symptom was a class of API-test 404s that look like missing routes
# but are not: the route is registered and reached, and the handler 404s because
# the row it looks up was never seeded. Concretely,
# GET /api/taxonomy/prompt-templates 404s whenever taxonomy.version has no
# status='active' row, because lookupPromptTemplate joins
# prompt_template -> version WHERE v.status='active'.
#
# These seeds are all written INSERT ... WHERE NOT EXISTS, so re-running is a
# no-op. That is what makes it safe to run this on every deploy.
#
# WHY A HOST-SIDE SCRIPT AND NOT A BOOT HOOK IN THE GATEWAY
# ---------------------------------------------------------
# services/api-gateway/Dockerfile COPYs packages/ services/ native/ tools/ and
# scripts/ — it does NOT copy tests/. So the gateway image cannot read these
# files at boot even though it already auto-applies per-SDK migrations. The prod
# host, by contrast, has the whole repo checked out at /home/ec2-user/projexcloud
# and tracks origin/main, so the .sql files ARE on disk there. Running them from
# the host needs no image change and no new build.
#
# THESE ARE QA FIXTURES, NOT PRODUCT DATA
# ---------------------------------------
# They create known-id rows that the api_definitions reference. That is exactly
# what you want on a staging/QA target and is NOT what you want in a real
# customer-facing production database. Hence the explicit opt-in below: there is
# no default-on path.
#
# USAGE (on the deploy host, from the repo root):
#   scripts/setup/apply-qa-seeds.sh --yes
#   scripts/setup/apply-qa-seeds.sh --yes --only taxonomy_seed_prompt_template.sql
#   scripts/setup/apply-qa-seeds.sh --dry-run
#
# Overrides:
#   PG_CONTAINER (default projexcloud_pg)
#   PG_USER      (default: POSTGRES_USER from the container)
#   PG_DB        (default: POSTGRES_DB   from the container)
#===============================================================================

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
SEED_DIR="$REPO_ROOT/tests/setup_scripts"

PG_CONTAINER="${PG_CONTAINER:-projexcloud_pg}"
CONFIRM=false
DRY_RUN=false
ONLY=""

while [ $# -gt 0 ]; do
    case "$1" in
        --yes|-y)   CONFIRM=true ;;
        --dry-run)  DRY_RUN=true ;;
        --only)     ONLY="${2:-}"; shift ;;
        -h|--help)  sed -n '2,60p' "$0"; exit 0 ;;
        *) echo "Unknown argument: $1" >&2; exit 2 ;;
    esac
    shift
done

if [ ! -d "$SEED_DIR" ]; then
    echo "ERROR: seed directory not found: $SEED_DIR" >&2
    exit 1
fi

if ! docker inspect "$PG_CONTAINER" >/dev/null 2>&1; then
    echo "ERROR: Postgres container '$PG_CONTAINER' not found." >&2
    echo "       Set PG_CONTAINER=<name> if your stack uses a different name." >&2
    exit 1
fi

# Read the credentials from the container itself rather than requiring .env.prod
# to be sourced — the container is the authority on what it was started with.
PG_USER="${PG_USER:-$(docker exec "$PG_CONTAINER" printenv POSTGRES_USER 2>/dev/null)}"
PG_DB="${PG_DB:-$(docker exec "$PG_CONTAINER" printenv POSTGRES_DB 2>/dev/null)}"

if [ -z "${PG_USER:-}" ] || [ -z "${PG_DB:-}" ]; then
    echo "ERROR: could not resolve POSTGRES_USER / POSTGRES_DB from $PG_CONTAINER." >&2
    echo "       Pass them explicitly: PG_USER=... PG_DB=... $0 --yes" >&2
    exit 1
fi

# Collect seeds in filename order. The numeric prefixes (00_, 10_, ...) exist so
# that fixtures with implicit ordering requirements apply in a stable sequence.
#
# SKIP PER-DEF FIXTURES. A seed containing a {{cache:...}} placeholder is NOT a
# deploy-time fixture: it is attached to an individual api_definition via
# "setupScript" + "testability": "semi-auto", and is meant to run per-def at test
# time, once the producer it references (usually auth.signup-tenant) has resolved
# and the placeholder has a real value. Applying one here is not just wrong, it is
# impossible — the literal '{{cache:...}}' fails the uuid cast. Filter them out so
# a clean run means "every deploy-time seed applied", instead of two guaranteed
# failures that train you to ignore the summary.
#
# NOTE: as of this writing the Test MCP carries setupScript through its data model
# (api_library_client.py:1693, server.py:143) but never executes it, so these
# per-def fixtures do not actually run anywhere yet. That is a runner gap, not
# something this script should paper over by force-applying them with a fabricated
# tenant id.
mapfile -t ALL_SQL < <(find "$SEED_DIR" -maxdepth 1 -name '*.sql' -type f | sort)
SEEDS=()
SKIPPED=()
for f in "${ALL_SQL[@]}"; do
    if grep -q '{{[a-z]*:' "$f" 2>/dev/null; then
        SKIPPED+=("$(basename "$f")")
    else
        SEEDS+=("$f")
    fi
done
if [ -n "$ONLY" ]; then
    SEEDS=("$SEED_DIR/$ONLY")
    if [ ! -f "${SEEDS[0]}" ]; then
        echo "ERROR: --only file not found: ${SEEDS[0]}" >&2
        exit 1
    fi
fi

if [ ${#SEEDS[@]} -eq 0 ]; then
    echo "No .sql seeds found in $SEED_DIR — nothing to do."
    exit 0
fi

echo "=============================================================="
echo " QA fixture seeds"
echo "=============================================================="
echo "  container : $PG_CONTAINER"
echo "  database  : $PG_DB (user: $PG_USER)"
echo "  seeds     : ${#SEEDS[@]}"
if [ ${#SKIPPED[@]} -gt 0 ]; then
    echo "  skipped   : ${#SKIPPED[@]} per-def fixture(s) with {{cache:}} placeholders —"
    for s in "${SKIPPED[@]}"; do echo "              $s"; done
    echo "              these belong to the test runner, not to deploy."
fi
echo ""

if [ "$DRY_RUN" = true ]; then
    for f in "${SEEDS[@]}"; do echo "  would apply: $(basename "$f")"; done
    echo ""
    echo "Dry run only — nothing was applied."
    exit 0
fi

if [ "$CONFIRM" != true ]; then
    echo "Refusing to run without --yes." >&2
    echo "These seeds insert fixed-id QA rows. That is appropriate for a" >&2
    echo "staging/QA database and NOT for a customer-facing production one." >&2
    exit 2
fi

applied=0
failed=0
for f in "${SEEDS[@]}"; do
    name="$(basename "$f")"
    printf '  %-42s ' "$name"
    # ON_ERROR_STOP so a broken seed reports instead of silently half-applying.
    # Each file is its own psql invocation, so one failure does not abort the rest.
    if err=$(docker exec -i "$PG_CONTAINER" \
                psql -U "$PG_USER" -d "$PG_DB" -v ON_ERROR_STOP=1 -q < "$f" 2>&1); then
        echo "ok"
        applied=$((applied + 1))
    else
        echo "FAILED"
        echo "$err" | sed 's/^/      /' | tail -6
        failed=$((failed + 1))
    fi
done

echo ""
echo "  applied: $applied   failed: $failed"
echo ""
if [ "$failed" -gt 0 ]; then
    echo "One or more seeds failed. They are idempotent, so it is safe to fix the"
    echo "cause and re-run this script."
    exit 1
fi
echo "All seeds applied. Re-run the API suite to confirm the data-dependent"
echo "404s are cleared:  mcp-server/run-all-tests.sh api --env staging"
