#!/bin/bash
#===============================================================================
# ProjexLight Multi-Project Setup Script
#===============================================================================
# Smart master script that detects existing containers and only creates what's
# needed. Supports multi-project architecture where a single set of MCP
# containers serves multiple projects.
#
# Usage:
#   ./setup-all.sh                    - Interactive setup (first run or new project)
#   ./setup-all.sh --status           - Check status of all containers
#   ./setup-all.sh --register         - Register this project with existing MCP
#   ./setup-all.sh --install-hooks    - Install git hooks only
#   ./setup-all.sh --force            - Force restart all containers
#
# Container Detection:
#   - If MCP containers exist and are running, skips creation
#   - If database container exists but different type needed, creates new one
#   - Auto-registers first project, prompts UI for subsequent projects
#
# Supported Databases:
#   PostgreSQL, MySQL, MariaDB, MongoDB, Redis, Cassandra, DynamoDB, SQLite
#===============================================================================

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
PROJECT_NAME=$(basename "$PROJECT_ROOT")
CONFIG_FILE="$SCRIPT_DIR/mcp-config.json"

#===============================================================================
# Shared registry location (single source of truth, cross-OS)
#===============================================================================
# The registered_projects.json lives in the user's hidden home folder
# (~/.projexlight) and is mounted into BOTH the Dev and Test MCP containers at a
# fixed path (/registry). This block resolves that folder in a Docker-mountable
# form and exposes the host JSON path for local jq/grep operations.

# Host registry DIR in Docker-mountable form: C:/Users/me/.projexlight (Win) or
# /home/me/.projexlight (*nix). Works on Linux, macOS, Git-Bash/MSYS, WSL.
get_registry_host_dir() {
    local home="${HOME:-}"
    if [ -z "$home" ] && [ -n "${USERPROFILE:-}" ]; then
        home="${USERPROFILE//\\//}"
        if [[ "$home" =~ ^([A-Za-z]):(.*)$ ]]; then
            home="/${BASH_REMATCH[1],,}${BASH_REMATCH[2]}"
        fi
    fi
    local dir="$home/.projexlight"
    mkdir -p "$dir" 2>/dev/null || true
    # Git-Bash/MSYS: /c/Users/.. -> C:/Users/.. for Docker Desktop bind mounts
    if [[ "$dir" =~ ^/([a-z])/(.*) ]]; then
        echo "${BASH_REMATCH[1]^}:/${BASH_REMATCH[2]}"
    else
        echo "$dir"
    fi
}

# Ensure PROJEX_REGISTRY_DIR_HOST is present/fresh in the given .env (so both
# compose files bind-mount the shared registry). Default: this script's .env.
ensure_registry_env() {
    local env_file="${1:-$SCRIPT_DIR/.env}"
    local host_dir; host_dir="$(get_registry_host_dir)"
    touch "$env_file" 2>/dev/null || true
    if grep -q '^PROJEX_REGISTRY_DIR_HOST=' "$env_file" 2>/dev/null; then
        if [[ "$OSTYPE" == "darwin"* ]]; then
            sed -i '' "s#^PROJEX_REGISTRY_DIR_HOST=.*#PROJEX_REGISTRY_DIR_HOST=$host_dir#" "$env_file"
        else
            sed -i "s#^PROJEX_REGISTRY_DIR_HOST=.*#PROJEX_REGISTRY_DIR_HOST=$host_dir#" "$env_file"
        fi
    else
        printf '\n# Shared project registry host dir (single source of truth)\nPROJEX_REGISTRY_DIR_HOST=%s\n' "$host_dir" >> "$env_file"
    fi
}

# The shared registry JSON on the host, for local jq/grep reads.
REGISTRY_FILE="$(get_registry_host_dir)/registered_projects.json"

# Container names
DEV_MCP_CONTAINER="projexlight-dev-mcp"
TEST_MCP_CONTAINER="projexlight-test-mcp"
DB_CONTAINER_PREFIX="projexlight"

# Default ports
DEV_MCP_PORT=8766
TEST_MCP_PORT=8000

# Colors
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
NC='\033[0m'

log() { echo -e "${GREEN}[SETUP]${NC} $1"; }
warn() { echo -e "${YELLOW}[SETUP]${NC} $1"; }
error() { echo -e "${RED}[SETUP]${NC} $1" >&2; }
info() { echo -e "${CYAN}[SETUP]${NC} $1"; }

#===============================================================================
# Path Conversion Functions
#===============================================================================

# Convert Windows path to Unix path (for Docker compatibility)
# Example: C:\Users\srima\test_projex2 -> /c/Users/srima/test_projex2
to_unix_path() {
    local path="$1"

    # Check if already Unix path
    if [[ "$path" == /* ]]; then
        echo "$path"
        return
    fi

    # Convert Windows path: C:\Users\... -> /c/Users/...
    # Replace backslashes with forward slashes
    path="${path//\\//}"

    # Convert drive letter: C: -> /c
    if [[ "$path" =~ ^([A-Za-z]):(.*)$ ]]; then
        local drive="${BASH_REMATCH[1]}"
        local rest="${BASH_REMATCH[2]}"
        path="/${drive,,}${rest}"  # ${drive,,} converts to lowercase
    fi

    echo "$path"
}

# Get the Unix path for the project root
get_unix_project_path() {
    to_unix_path "$PROJECT_ROOT"
}

print_header() {
    echo ""
    echo -e "${BLUE}═══════════════════════════════════════════════════════════════${NC}"
    echo -e "${BLUE}   ProjexLight Multi-Project Setup${NC}"
    echo -e "${BLUE}═══════════════════════════════════════════════════════════════${NC}"
    echo ""
}

#===============================================================================
# Container Detection Functions
#===============================================================================

# Check if a container exists (running or stopped)
container_exists() {
    docker ps -a --format '{{.Names}}' | grep -q "^$1$"
}

# Check if a container is running
container_running() {
    docker ps --format '{{.Names}}' | grep -q "^$1$"
}

# Check if Dev MCP is running and healthy
check_dev_mcp() {
    if container_running "$DEV_MCP_CONTAINER"; then
        if curl -sf "http://localhost:${DEV_MCP_PORT}/health" > /dev/null 2>&1; then
            return 0  # Running and healthy
        fi
    fi
    return 1
}

# Check if Test MCP is running and healthy
check_test_mcp() {
    if container_running "$TEST_MCP_CONTAINER"; then
        if curl -sf "http://localhost:${TEST_MCP_PORT}/health" > /dev/null 2>&1; then
            return 0  # Running and healthy
        fi
    fi
    return 1
}

# Get database type from mcp-config.json
get_db_type() {
    local db_type="postgresql"  # default

    if [ -f "$CONFIG_FILE" ]; then
        if command -v jq &> /dev/null; then
            db_type=$(jq -r '.databaseConfig.type // "postgresql"' "$CONFIG_FILE" 2>/dev/null)
        else
            db_type=$(grep -o '"type"[[:space:]]*:[[:space:]]*"[^"]*"' "$CONFIG_FILE" 2>/dev/null | grep -o '"[^"]*"$' | tr -d '"' | head -1)
        fi
    fi

    # Normalize
    case "$db_type" in
        postgres) db_type="postgresql" ;;
        mongo) db_type="mongodb" ;;
    esac

    echo "$db_type"
}

# Get database container name for a given type
get_db_container_name() {
    local db_type=$1
    case "$db_type" in
        postgresql|postgres) echo "${DB_CONTAINER_PREFIX}-postgres" ;;
        mysql) echo "${DB_CONTAINER_PREFIX}-mysql" ;;
        mariadb) echo "${DB_CONTAINER_PREFIX}-mariadb" ;;
        mongodb|mongo) echo "${DB_CONTAINER_PREFIX}-mongodb" ;;
        redis) echo "${DB_CONTAINER_PREFIX}-redis" ;;
        cassandra) echo "${DB_CONTAINER_PREFIX}-cassandra" ;;
        dynamodb) echo "${DB_CONTAINER_PREFIX}-dynamodb" ;;
        sqlite) echo "sqlite_no_container" ;;
        *) echo "${DB_CONTAINER_PREFIX}-postgres" ;;
    esac
}

# Check if any database container is running
get_running_db_container() {
    for db_type in postgresql mysql mariadb mongodb redis cassandra dynamodb; do
        local container=$(get_db_container_name "$db_type")
        if container_running "$container"; then
            echo "$db_type"
            return 0
        fi
    done
    return 1
}

# Check if this is the first project (no MCP containers exist)
is_first_project() {
    if container_exists "$DEV_MCP_CONTAINER" || container_exists "$TEST_MCP_CONTAINER"; then
        return 1  # Not first project
    fi
    return 0  # First project
}

#===============================================================================
# Credential Sync Functions (Auto-fix stale API keys)
#===============================================================================

# Check if registered project credentials match mcp-config.json
# Returns 0 if credentials match or no registration exists, 1 if mismatch
check_credential_sync() {
    if ! check_dev_mcp; then
        return 0  # MCP not running, can't check
    fi

    # Get API key from mcp-config.json
    local config_api_key=""
    if [ -f "$CONFIG_FILE" ] && command -v jq &> /dev/null; then
        config_api_key=$(jq -r '.encryptedPlatformApiKey // .sessionToken // ""' "$CONFIG_FILE" 2>/dev/null)
    fi

    if [ -z "$config_api_key" ]; then
        return 0  # No API key in config, nothing to sync
    fi

    # Get project ID from config
    local project_id=""
    if command -v jq &> /dev/null; then
        project_id=$(jq -r '.projectId // ""' "$CONFIG_FILE" 2>/dev/null)
    fi

    if [ -z "$project_id" ]; then
        return 0  # No project ID, can't check
    fi

    # Get registered project's API key from MCP
    local registered_api_key=""
    local projects_response
    projects_response=$(curl -sf "http://localhost:${DEV_MCP_PORT}/api/projects" 2>/dev/null) || return 0

    if command -v jq &> /dev/null; then
        registered_api_key=$(echo "$projects_response" | jq -r --arg pid "$project_id" '.projects[] | select(.projectId == $pid) | .apiKey // ""' 2>/dev/null)
    fi

    if [ -z "$registered_api_key" ]; then
        return 0  # Project not registered yet
    fi

    # Bug A fix: compare the FULL key, not a 50-char prefix. Prefix compare
    # misses tail-only drift and falsely reports "in sync", leaving credentials stale.
    if [ "$config_api_key" != "$registered_api_key" ]; then
        warn "API key mismatch detected!"
        warn "  Config key starts with: ${config_api_key:0:20}..."
        warn "  Registered key starts with: ${registered_api_key:0:20}..."
        return 1  # Mismatch
    fi

    return 0  # Match
}

# Convert a registry projectPath into a path THIS shell can stat.
#
# The registry stores the normalized Unix form (/c/Users/... on Windows). Git-Bash,
# macOS and Linux can stat that directly. WSL cannot: there the same folder lives
# under /mnt/c/..., so a bare [ -d /c/Users/... ] is always false and would make
# every Windows project look deleted.
# On NATIVE LINUX, pin the containers to the invoking uid:gid.
#
# Docker there runs as root, so everything the MCP writes into your project
# (.mcp-logs/, test-results/, feedback/) lands root-owned and you cannot clean it
# up without sudo. Docker Desktop (macOS/Windows) maps ownership inside its VM and
# actually NEEDS root for git-hook installation, so this is deliberately skipped
# there -- including WSL, which goes through Docker Desktop.
ensure_run_as_env() {
    local env_file="${1:-$SCRIPT_DIR/.env}"
    [ -f "$env_file" ] || return 0
    [ "$(uname -s)" = "Linux" ] || return 0
    [ -n "${WSL_DISTRO_NAME:-}" ] && return 0
    grep -qi microsoft /proc/version 2>/dev/null && return 0
    grep -q '^MCP_RUN_AS=' "$env_file" 2>/dev/null && return 0
    echo "MCP_RUN_AS=$(id -u):$(id -g)" >> "$env_file"
    log "Set MCP_RUN_AS=$(id -u):$(id -g) — container-written files stay owned by you"
}

host_testable_path() {
    local p="$1"
    if [ -n "${WSL_DISTRO_NAME:-}" ] || grep -qi microsoft /proc/version 2>/dev/null; then
        if [[ "$p" =~ ^/([a-zA-Z])(/.*)?$ ]]; then
            echo "/mnt/${BASH_REMATCH[1],,}${BASH_REMATCH[2]}"
            return 0
        fi
    fi
    echo "$p"
}

# Remove registry entries whose project FOLDER is genuinely gone from disk.
#
# This lives on the HOST on purpose. The MCP containers can only see their own
# mounts (/workspace, /projects/additionalN), so from inside them "unmounted" and
# "deleted" are the same observation -- acting on it there destroyed live project
# registrations, apiKey included. The containers now only ever DEMOTE. This is the
# single place with enough information to actually delete.
prune_deleted_projects() {
    command -v jq &> /dev/null || return 0
    local reg="$REGISTRY_FILE"
    [ -f "$reg" ] || return 0

    local total gone=() pid path testable
    total=$(jq -r 'length' "$reg" 2>/dev/null || echo 0)
    [ "$total" -gt 0 ] 2>/dev/null || return 0

    # NOTE the `tr -d '\r'`: jq built for MSYS/Git-Bash emits CRLF, and a trailing
    # CR inside $path makes [ -d ] fail for EVERY project -- i.e. the prune would
    # consider the entire registry deleted. Strip it before any comparison.
    while IFS=$'\t' read -r pid path; do
        pid="${pid%$'\r'}"; path="${path%$'\r'}"
        [ -z "$pid" ] && continue
        # No recorded path -> we cannot prove it is gone, so never touch it.
        if [ -z "$path" ] || [ "$path" = "null" ]; then
            continue
        fi
        testable="$(host_testable_path "$path")"
        [ -d "$testable" ] || gone+=("$pid")
    done < <(jq -r 'to_entries[] | "\(.key)\t\(.value.projectPath // "")"' "$reg" 2>/dev/null | tr -d '\r')

    [ ${#gone[@]} -eq 0 ] && return 0

    # Safety net: if EVERY entry looks missing, the path conversion is wrong for
    # this platform (or the registry is mid-write) -- never wipe the whole file.
    if [ ${#gone[@]} -ge "$total" ]; then
        warn "Registry prune skipped: all $total project paths look missing (path-translation issue?)"
        return 0
    fi

    log "Pruning ${#gone[@]} registry entr(y/ies) whose folder no longer exists:"
    local p
    for p in "${gone[@]}"; do
        log "  - $p ($(jq -r --arg i "$p" '.[$i].projectName // "?"' "$reg"))"
    done

    cp "$reg" "${reg}.bak" 2>/dev/null || true
    local ptmp="${reg}.tmp"
    local filter='.'
    for p in "${gone[@]}"; do filter="$filter | del(.[\"$p\"])"; done
    if jq "$filter" "$reg" > "$ptmp" 2>/dev/null && [ -s "$ptmp" ] && jq -e . "$ptmp" >/dev/null 2>&1; then
        mv "$ptmp" "$reg"
        log "Registry pruned (backup at $(basename "$reg").bak)"
    else
        rm -f "$ptmp"
        warn "Registry prune failed (jq) - registry left unchanged"
    fi
}

# Ensure THIS project's registry entry has COMPLETE metadata (owner OR guest).
#
# Why this exists: on a fresh/empty registry the container self-registers a BARE
# entry (projectId+apiKey+sprintId+isOwner) but leaves projectPath, expiresAt and
# projectName empty (projectName defaults to the UUID). A null projectPath then
# (a) breaks set_context-by-path and (b) trips the owner-guard in register_project.
#
# Multi-project safe: setup-all.sh is always run from ONE project's mcp-server dir,
# so CONFIG_FILE.projectId identifies exactly which entry to complete, and
# get_unix_project_path gives THAT project's root (the same value written into
# PROJECT_PATH_MAPPINGS for this project). We patch ONLY .[$pid] and never touch the
# other registered projects, so owner + guests each get completed by their own run.
complete_project_metadata() {
    check_dev_mcp || return 0
    command -v jq &> /dev/null || return 0
    local reg="$REGISTRY_FILE"
    [ -f "$reg" ] || return 0
    [ -f "$CONFIG_FILE" ] || return 0

    local pid; pid=$(jq -r '.projectId // ""' "$CONFIG_FILE" 2>/dev/null)
    [ -z "$pid" ] && return 0
    # Only complete an entry that already exists for THIS project's id (owner or
    # guest). Registration itself is handled by register_project; we just fill gaps.
    local entry_exists; entry_exists=$(jq -r --arg p "$pid" 'has($p)' "$reg" 2>/dev/null)
    [ "$entry_exists" = "true" ] || return 0

    local unix_path exp env sid name
    unix_path=$(get_unix_project_path)
    exp=$(jq -r '.expiresAt // ""' "$CONFIG_FILE" 2>/dev/null)
    env=$(jq -r '.environment // .activeEnvironment // "prod"' "$CONFIG_FILE" 2>/dev/null)
    sid=$(jq -r '.sprintId // ""' "$CONFIG_FILE" 2>/dev/null)
    name="$PROJECT_NAME"

    # Skip if already complete (path matches, expiresAt present, name not the UUID).
    local cur_path cur_exp cur_name
    cur_path=$(jq -r --arg p "$pid" '.[$p].projectPath // ""' "$reg" 2>/dev/null)
    cur_exp=$(jq -r --arg p "$pid" '.[$p].expiresAt // ""' "$reg" 2>/dev/null)
    cur_name=$(jq -r --arg p "$pid" '.[$p].projectName // ""' "$reg" 2>/dev/null)
    if [ "$cur_path" = "$unix_path" ] && [ -n "$cur_exp" ] && [ "$cur_name" = "$name" ]; then
        return 0
    fi

    log "Completing owner registry metadata (projectPath/expiresAt/projectName)..."
    cp "$reg" "${reg}.bak" 2>/dev/null || true
    local tmp="${reg}.tmp"
    if jq --arg p "$pid" --arg path "$unix_path" --arg exp "$exp" \
          --arg env "$env" --arg sid "$sid" --arg name "$name" '
            if (.[$p] == null) then . else
              .[$p].projectPath   = $path
              | .[$p].workspacePath = $path
              | (if $exp != "" then .[$p].expiresAt = $exp else . end)
              | .[$p].environment = $env
              | (if $sid != "" then .[$p].sprintId = $sid else . end)
              | (if ($name != "" and $name != $p) then .[$p].projectName = $name else . end)
              | .[$p].tokenStatus = "active"
            end' "$reg" > "$tmp"; then
        mv "$tmp" "$reg"
        docker restart "$DEV_MCP_CONTAINER" > /dev/null 2>&1 || true
        local i
        for i in $(seq 1 20); do
            sleep 2
            curl -sf "http://localhost:${DEV_MCP_PORT}/api/projects" > /dev/null 2>&1 && {
                log "Owner metadata completed and reloaded after $((i*2))s"; return 0; }
        done
        warn "Container slow to become ready after metadata completion (file already written)"
        return 0
    else
        rm -f "$tmp"
        warn "Failed to complete owner metadata via jq"
        return 1
    fi
}

# Overwrite apiKey in the persisted registered_projects.json and restart the
# container so the new value is loaded into memory.
#
# Why this exists: POST /api/projects/register returns early when project_id is
# already known and does NOT update apiKey on re-registration. DELETE refuses to
# remove owner projects. So the only way to update the cached apiKey for an
# owner project is to edit the persisted file directly, then restart.
_overwrite_persisted_apikey_and_restart() {
    local project_id="$1"
    local new_api_key="$2"
    local persisted_file="$REGISTRY_FILE"

    if [ ! -f "$persisted_file" ]; then
        warn "Persisted projects file not found at $persisted_file"
        return 1
    fi

    if ! command -v jq &> /dev/null; then
        warn "jq required to overwrite persisted apiKey; install jq or remove + re-add the project manually"
        return 1
    fi

    log "Owner project detected — updating persisted apiKey directly..."
    cp "$persisted_file" "${persisted_file}.bak" 2>/dev/null || true

    local tmp_file="${persisted_file}.tmp"
    # Bug A fix: refresh metadata (expiresAt/environment/sprintId/projectName),
    # not just apiKey. Otherwise a refreshed token keeps the OLD expiresAt and the
    # server marks tokenStatus="expired" even though the key is valid.
    local cfg_exp cfg_env cfg_sid cfg_name
    cfg_exp=$(jq -r '.expiresAt // ""' "$CONFIG_FILE" 2>/dev/null)
    cfg_env=$(jq -r '.environment // .activeEnvironment // "prod"' "$CONFIG_FILE" 2>/dev/null)
    cfg_sid=$(jq -r '.sprintId // ""' "$CONFIG_FILE" 2>/dev/null)
    cfg_name="$PROJECT_NAME"
    if ! jq --arg pid "$project_id" --arg key "$new_api_key" \
            --arg exp "$cfg_exp" --arg env "$cfg_env" --arg sid "$cfg_sid" --arg pn "$cfg_name" \
            '.[$pid].apiKey = $key
             | (if $exp != "" then .[$pid].expiresAt = $exp else . end)
             | .[$pid].environment = $env
             | (if $sid != "" then .[$pid].sprintId = $sid else . end)
             | (if ($pn != "" and $pn != $pid) then .[$pid].projectName = $pn else . end)
             | .[$pid].tokenStatus = "active"' "$persisted_file" > "$tmp_file"; then
        warn "Failed to update persisted apiKey via jq"
        rm -f "$tmp_file"
        return 1
    fi
    mv "$tmp_file" "$persisted_file"

    log "Restarting MCP container so the new apiKey is loaded into memory..."
    docker restart "$DEV_MCP_CONTAINER" > /dev/null 2>&1 || {
        warn "docker restart failed for $DEV_MCP_CONTAINER"
        return 1
    }

    # Wait for the server to be fully serving. Poll /api/projects rather than
    # /health — the FastAPI app responds 200 on /health before the route
    # handlers (and the in-memory project registry) are actually ready, so
    # /health is unreliable as a readiness signal. 30s is enough for a warm
    # restart; on a cold start the SchemaSyncAgent can take longer, in which
    # case the script reports "not ready" but the file rewrite is already done
    # and the container will finish coming up on its own.
    local i
    for i in $(seq 1 15); do
        sleep 2
        if curl -sf "http://localhost:${DEV_MCP_PORT}/api/projects" > /dev/null 2>&1; then
            log "MCP container ready after $((i*2))s"
            return 0
        fi
    done

    warn "MCP container did not become ready within 30s after restart (file already rewritten; container may still be starting)"
    return 1
}

# Sync credentials by unregistering and re-registering project
sync_credentials() {
    local project_id=""
    local config_api_key=""
    if [ -f "$CONFIG_FILE" ] && command -v jq &> /dev/null; then
        project_id=$(jq -r '.projectId // ""' "$CONFIG_FILE" 2>/dev/null)
        config_api_key=$(jq -r '.encryptedPlatformApiKey // .sessionToken // ""' "$CONFIG_FILE" 2>/dev/null)
    fi

    if [ -z "$project_id" ]; then
        warn "Cannot sync credentials - no project ID in config"
        return 1
    fi

    log "Syncing credentials for project: $project_id"

    # Try to unregister. For owner projects this returns 403, in which case we
    # fall back to editing the persisted file + restarting the container.
    local delete_http
    delete_http=$(curl -s -o /dev/null -w '%{http_code}' \
        -X DELETE "http://localhost:${DEV_MCP_PORT}/api/projects/${project_id}" 2>/dev/null || echo "000")

    if [ "$delete_http" = "200" ] || [ "$delete_http" = "204" ]; then
        log "Removed stale registration (HTTP $delete_http)"
        sleep 1
        log "Re-registering with updated credentials..."
        register_project "false"
        log "Credential sync complete!"
        return 0
    fi

    if [ "$delete_http" = "403" ]; then
        if [ -z "$config_api_key" ]; then
            warn "DELETE returned 403 (owner project) but no apiKey in config to write back"
            return 1
        fi
        if _overwrite_persisted_apikey_and_restart "$project_id" "$config_api_key"; then
            log "Credential sync complete!"
            return 0
        else
            warn "File-based credential sync failed"
            return 1
        fi
    fi

    warn "Unexpected DELETE response (HTTP $delete_http); attempting standard re-register anyway..."
    sleep 1
    register_project "false"
    log "Credential sync complete!"
}

# Auto-fix credential mismatches (main entry point)
auto_fix_credentials() {
    if ! check_dev_mcp; then
        return 0  # MCP not running
    fi

    if ! check_credential_sync; then
        warn "Credential mismatch detected - auto-fixing..."
        sync_credentials
        # apiKey sync already refreshes metadata; still ensure completeness below.
    else
        info "Credentials are in sync"
    fi

    # Always ensure the owner entry has complete metadata (projectPath/expiresAt/
    # projectName). The container's fresh self-registration leaves these empty even
    # when the apiKey matches, which breaks set_context-by-path.
    complete_project_metadata
    # Host-side cleanup: drop entries whose folder is really gone. Runs AFTER
    # registration so THIS project is present and can never prune itself.
    prune_deleted_projects
    return 0
}

#===============================================================================
# Project Registration Functions (Local .env Setup)
#===============================================================================

# Get the owner project's mcp-server directory (where Docker Compose was launched)
# This is the .env that Docker actually reads for volume mounts.
# Returns the path on stdout, or empty string if not found.
get_owner_env_dir() {
    local owner_dir=""

    # Method 1: Docker inspect - get the compose working directory from the running container
    if container_running "$DEV_MCP_CONTAINER"; then
        owner_dir=$(docker inspect "$DEV_MCP_CONTAINER" \
            --format='{{index .Config.Labels "com.docker.compose.project.working_dir"}}' 2>/dev/null || echo "")
        # Normalize Windows path separators
        owner_dir="${owner_dir//\\//}"
    fi

    # Method 2: Check /workspace mount source (the owner project root + /mcp-server)
    if [ -z "$owner_dir" ] && container_running "$DEV_MCP_CONTAINER"; then
        local workspace_source
        workspace_source=$(docker inspect "$DEV_MCP_CONTAINER" \
            --format='{{range .Mounts}}{{if eq .Destination "/workspace"}}{{.Source}}{{end}}{{end}}' 2>/dev/null || echo "")
        workspace_source="${workspace_source//\\//}"
        if [ -n "$workspace_source" ] && [ -f "$workspace_source/mcp-server/.env" ]; then
            owner_dir="$workspace_source/mcp-server"
        fi
    fi

    echo "$owner_dir"
}

# Setup local .env for project path mappings before starting containers
# This ensures PROJECT_PATH_MAPPINGS is set correctly for the MCP server
# Registration data is stored in the shared registry (~/.projexlight) by MCP server
create_local_registration() {
    local is_owner="${1:-false}"
    local unix_path=$(get_unix_project_path)

    if [ "$is_owner" = "true" ]; then
        # Owner project maps to /workspace
        log "Setting up path mappings for owner project..."
        update_path_mappings "$unix_path" "/workspace" "$SCRIPT_DIR/.env"
    else
        # Find next available additional slot from the shared registry
        local slot=1
        local reg_file="$REGISTRY_FILE"

        if [ -f "$reg_file" ] && command -v jq &> /dev/null; then
            # Count existing additional projects (those with containerPath containing /projects/additional)
            local existing=$(jq -r '[.[] | select(.containerPath | startswith("/projects/additional"))] | length' "$reg_file" 2>/dev/null || echo "0")
            slot=$((existing + 1))
        fi

        if [ $slot -gt 3 ]; then
            echo ""
            echo -e "${RED}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
            echo -e "${RED}❌ PROJECT LIMIT REACHED${NC}"
            echo -e "${RED}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
            echo ""
            echo -e "${YELLOW}ProjexLight MCP supports up to 4 projects total:${NC}"
            echo -e "   • 1 owner project (the first project that created the MCP containers)"
            echo -e "   • 3 additional projects connected to the same MCP"
            echo ""
            echo -e "${YELLOW}Currently registered additional projects:${NC}"
            if [ -f "$REGISTRY_FILE" ] && command -v jq &> /dev/null; then
                jq -r '.[] | select(.containerPath | startswith("/projects/additional")) | "   • \(.projectName) (\(.projectPath))"' "$REGISTRY_FILE" 2>/dev/null || echo "   (unable to list)"
            fi
            echo ""
            echo -e "${BLUE}To free a slot, unregister an existing project at:${NC}"
            echo -e "   http://localhost:${DEV_MCP_PORT}/projects"
            echo ""
            return 1
        fi

        log "Setting up path mappings for additional project (slot $slot)..."

        # Update local .env (for reference)
        update_additional_project_env $slot "$unix_path" "$SCRIPT_DIR/.env"

        # CRITICAL: Also update the OWNER project's .env (where Docker reads volumes from)
        # Without this, the container won't have the new project mounted
        local owner_dir
        owner_dir=$(get_owner_env_dir)
        if [ -n "$owner_dir" ] && [ -f "$owner_dir/.env" ] && [ "$owner_dir" != "$SCRIPT_DIR" ]; then
            log "Updating owner project .env at: $owner_dir"
            update_additional_project_env $slot "$unix_path" "$owner_dir/.env"
            NEEDS_CONTAINER_RESTART=true
        elif [ -z "$owner_dir" ]; then
            warn "Could not find owner project's .env - container may need manual restart"
            warn "After restart, run: ./setup-all.sh --register"
        fi
    fi
}

# Update PROJECT_PATH_MAPPINGS in a given .env file
update_path_mappings() {
    local unix_path="$1"
    local container_path="$2"
    local env_file="${3:-$SCRIPT_DIR/.env}"

    # Read existing mappings or create new
    local current_mappings=""
    if [ -f "$env_file" ]; then
        current_mappings=$(grep "^PROJECT_PATH_MAPPINGS=" "$env_file" 2>/dev/null | cut -d'=' -f2- | tr -d "'" || echo "")
    fi

    # Check if this path is already mapped (avoid duplicates)
    if echo "$current_mappings" | grep -q "\"$unix_path\""; then
        log "Path $unix_path already in PROJECT_PATH_MAPPINGS ($(basename $(dirname "$env_file")))"
        return 0
    fi

    # Parse existing JSON or start fresh
    if [ -z "$current_mappings" ] || [ "$current_mappings" = "{}" ]; then
        current_mappings="{\"$unix_path\":\"$container_path\"}"
    else
        # Add new mapping to existing JSON
        # Remove trailing } and add new entry
        current_mappings="${current_mappings%\}},\"$unix_path\":\"$container_path\"}"
    fi

    # Update .env file
    if grep -q "^PROJECT_PATH_MAPPINGS=" "$env_file" 2>/dev/null; then
        # Update existing line
        if [[ "$OSTYPE" == "darwin"* ]]; then
            sed -i '' "s|^PROJECT_PATH_MAPPINGS=.*|PROJECT_PATH_MAPPINGS='$current_mappings'|" "$env_file"
        else
            sed -i "s|^PROJECT_PATH_MAPPINGS=.*|PROJECT_PATH_MAPPINGS='$current_mappings'|" "$env_file"
        fi
    else
        # Add new line
        echo "" >> "$env_file"
        echo "# Multi-project path mappings (JSON format)" >> "$env_file"
        echo "PROJECT_PATH_MAPPINGS='$current_mappings'" >> "$env_file"
    fi

    log "Updated PROJECT_PATH_MAPPINGS in $(basename $(dirname "$env_file"))/.env"
}

# Update ADDITIONAL_PROJECT_N environment variable in a given .env file
update_additional_project_env() {
    local slot=$1
    local unix_path="$2"
    local env_file="${3:-$SCRIPT_DIR/.env}"

    # Convert Unix path to Windows path for Docker volume mount
    # /c/Users/... -> C:/Users/...
    local windows_path="$unix_path"
    if [[ "$unix_path" =~ ^/([a-z])/(.*) ]]; then
        local drive="${BASH_REMATCH[1]}"
        local rest="${BASH_REMATCH[2]}"
        windows_path="${drive^}:/$rest"
    fi

    # Check if this path is already set for this slot
    if grep -q "^ADDITIONAL_PROJECT_${slot}=${windows_path}$" "$env_file" 2>/dev/null; then
        log "ADDITIONAL_PROJECT_${slot} already set in $(basename $(dirname "$env_file"))/.env"
        # Still update path mappings in case they're missing
        update_path_mappings "$unix_path" "/projects/additional${slot}" "$env_file"
        return 0
    fi

    # Update or add ADDITIONAL_PROJECT_N
    if grep -q "^ADDITIONAL_PROJECT_${slot}=" "$env_file" 2>/dev/null; then
        if [[ "$OSTYPE" == "darwin"* ]]; then
            sed -i '' "s|^ADDITIONAL_PROJECT_${slot}=.*|ADDITIONAL_PROJECT_${slot}=$windows_path|" "$env_file"
        else
            sed -i "s|^ADDITIONAL_PROJECT_${slot}=.*|ADDITIONAL_PROJECT_${slot}=$windows_path|" "$env_file"
        fi
    else
        echo "" >> "$env_file"
        echo "# Additional project $slot volume mount" >> "$env_file"
        echo "ADDITIONAL_PROJECT_${slot}=$windows_path" >> "$env_file"
    fi

    # Also update path mappings
    update_path_mappings "$unix_path" "/projects/additional${slot}" "$env_file"

    log "Updated ADDITIONAL_PROJECT_${slot} in $(basename $(dirname "$env_file"))/.env"
}

# Check if this project is already registered in the shared registry.
is_project_registered() {
    local unix_path=$(get_unix_project_path)
    local check_file="$REGISTRY_FILE"

    [ -f "$check_file" ] || return 1

    # grep (not jq) by design: on Windows Git Bash / MSYS, bash rewrites Unix
    # absolute paths (/c/Users/...) to C:/Users/... before passing them to a
    # non-MSYS binary like jq, breaking the match. grep keeps the literal.
    if grep -q "\"projectPath\": *\"$unix_path\"" "$check_file" 2>/dev/null; then
        return 0
    fi

    return 1
}

#===============================================================================
# Setup Functions
#===============================================================================

check_prerequisites() {
    log "Checking prerequisites..."

    # Check Docker
    if ! command -v docker &> /dev/null; then
        error "Docker is not installed. Please install Docker first."
        exit 1
    fi

    if ! docker info &> /dev/null; then
        error "Docker daemon is not running. Please start Docker."
        exit 1
    fi

    # Check Docker Compose
    if docker compose version > /dev/null 2>&1; then
        COMPOSE_CMD="docker compose"
    elif docker-compose version > /dev/null 2>&1; then
        COMPOSE_CMD="docker-compose"
    else
        error "Docker Compose is not installed."
        exit 1
    fi

    # Check for git
    if ! command -v git &> /dev/null; then
        warn "Git is not installed. Hook installation will be skipped."
    fi

    # Load PROJEXLIGHT_API_URL from .env if not already set
    load_api_url_from_env

    # Ensure the shared-registry host path is written into .env so both compose
    # files bind-mount ~/.projexlight -> /registry (single source of truth).
    ensure_registry_env

    # Check config expiry for this project
    check_config_expiry

    log "Prerequisites OK"
}

#===============================================================================
# Config Expiry Check
#===============================================================================

# Check if the mcp-config.json for this project has expired or is expiring soon.
# Warns during setup so users don't discover it only at push time.
check_config_expiry() {
    if [ ! -f "$CONFIG_FILE" ]; then
        warn "No mcp-config.json found at: $CONFIG_FILE"
        warn "Setup will continue but API features will not work."
        return 0
    fi

    local expires_at=""
    if command -v jq &> /dev/null; then
        expires_at=$(jq -r '.expiresAt // empty' "$CONFIG_FILE" 2>/dev/null)
    else
        # Fallback: extract expiresAt with grep/sed
        expires_at=$(grep -o '"expiresAt"[[:space:]]*:[[:space:]]*"[^"]*"' "$CONFIG_FILE" 2>/dev/null | sed 's/.*"expiresAt"[[:space:]]*:[[:space:]]*"//;s/"//')
    fi

    if [ -z "$expires_at" ]; then
        return 0  # No expiry field — skip check
    fi

    # Parse expiry date (cross-platform: works on Linux, macOS, Windows Git Bash)
    local expires_epoch=""
    local now_epoch=""

    # Try GNU date first (Linux, Git Bash on Windows)
    if date -d "2000-01-01T00:00:00Z" +%s > /dev/null 2>&1; then
        expires_epoch=$(date -d "${expires_at}" +%s 2>/dev/null)
        now_epoch=$(date +%s)
    # Try BSD date (macOS)
    elif date -j -f "%Y-%m-%dT%H:%M:%S" "2000-01-01T00:00:00" +%s > /dev/null 2>&1; then
        local clean_date="${expires_at%%.*}"  # Remove fractional seconds
        clean_date="${clean_date%Z}"          # Remove trailing Z
        expires_epoch=$(date -j -f "%Y-%m-%dT%H:%M:%S" "$clean_date" +%s 2>/dev/null)
        now_epoch=$(date +%s)
    fi

    if [ -z "$expires_epoch" ] || [ -z "$now_epoch" ]; then
        return 0  # Could not parse date — skip check silently
    fi

    local diff_seconds=$((expires_epoch - now_epoch))
    local diff_days=$((diff_seconds / 86400))

    if [ $diff_seconds -le 0 ]; then
        # EXPIRED
        local days_ago=$(( (-diff_seconds) / 86400 ))
        echo ""
        echo -e "${RED}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
        echo -e "${RED}⚠️  MCP CONFIG EXPIRED ($days_ago day(s) ago)${NC}"
        echo -e "${RED}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
        echo -e "   Project:  ${YELLOW}$PROJECT_NAME${NC}"
        echo -e "   Config:   $CONFIG_FILE"
        echo -e "   Expired:  ${RED}$expires_at${NC}"
        echo ""
        echo -e "   ${YELLOW}API testing, code review, and platform reporting will NOT work.${NC}"
        echo -e "   Git hooks (pre-push) will fail when trying to run tests."
        echo ""
        echo -e "   ${BLUE}HOW TO FIX:${NC}"
        echo -e "   1. Go to ${CYAN}https://projexlight.com${NC}"
        echo -e "   2. Open your project > Code Generation Sessions"
        echo -e "   3. Click 'New Session' > CLI Export Wizard"
        echo -e "   4. Download the new export and copy mcp-config.json to:"
        echo -e "      ${GREEN}$CONFIG_FILE${NC}"
        echo -e "   5. Re-run this setup script"
        echo -e "${RED}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
        echo ""
        warn "Continuing setup with expired config..."
    elif [ $diff_days -le 7 ]; then
        # EXPIRING SOON
        echo ""
        echo -e "${YELLOW}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
        echo -e "${YELLOW}⚠️  MCP CONFIG EXPIRING SOON ($diff_days day(s) remaining)${NC}"
        echo -e "${YELLOW}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
        echo -e "   Project:  $PROJECT_NAME"
        echo -e "   Config:   $CONFIG_FILE"
        echo -e "   Expires:  ${YELLOW}$expires_at${NC}"
        echo ""
        echo -e "   ${BLUE}Please renew before it expires:${NC}"
        echo -e "   ProjexLight Portal > Project > Code Generation Sessions > New Session"
        echo -e "${YELLOW}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
        echo ""
    else
        log "Config valid ($diff_days days remaining)"
    fi
}

# Load PROJEXLIGHT_API_URL from .env file
load_api_url_from_env() {
    local env_file="$SCRIPT_DIR/.env"

    # Only load if not already set in environment
    if [ -z "${PROJEXLIGHT_API_URL:-}" ] && [ -f "$env_file" ]; then
        local api_url=$(grep -E "^PROJEXLIGHT_API_URL=" "$env_file" 2>/dev/null | cut -d'=' -f2- | tr -d '"' | tr -d "'")
        if [ -n "$api_url" ]; then
            export PROJEXLIGHT_API_URL="$api_url"
            info "Using API URL from .env: $api_url"
        fi
    fi

    # Default to production if not set
    export PROJEXLIGHT_API_URL="${PROJEXLIGHT_API_URL:-https://api.projexlight.com}"
}

# Setup Dev MCP container
setup_dev_mcp() {
    log "Setting up Dev MCP Server..."

    # If already healthy, nothing to do
    if check_dev_mcp; then
        info "Dev MCP is already running and healthy on port ${DEV_MCP_PORT}"
        info "Skipping creation - reusing existing container"
        return 0
    fi

    # If container is running but not healthy, wait a bit longer before restarting
    # This handles the case where container was just restarted and needs time
    if container_running "$DEV_MCP_CONTAINER"; then
        info "Dev MCP container running, waiting for health..."
        for i in {1..15}; do
            if check_dev_mcp; then
                log "Dev MCP is ready!"
                return 0
            fi
            echo -ne "${CYAN}[SETUP]${NC} Waiting for Dev MCP health... $i/15\r"
            sleep 2
        done
        echo ""
        # Still not healthy after waiting, need to restart
        warn "Dev MCP not responding after wait. Will restart..."
    fi

    # Containers MUST be created from the OWNER's mcp-server dir.
    #
    # dev-mcp-compose.yml mounts `../:/workspace` — relative to whichever
    # directory compose runs in. Running it from a GUEST silently makes that guest
    # /workspace, and the MCP server then sees the registered owner's path missing
    # from the container, concludes "owner folder repurposed", evicts that project
    # and persists a registry containing only the new one:
    #
    #   Loaded 2 registered projects from /registry/registered_projects.json
    #   Owner folder repurposed: evicting <owner>, promoting live <guest>
    #   Saved 1 registered projects to shared registry
    #
    # The owner's folder was never deleted — merely unmounted — but the container
    # cannot tell those apart. reload_containers_from_registry already resolves the
    # owner dir before running compose; container CREATION must do the same.
    local mcp_dir="$SCRIPT_DIR"
    local owner_dir_for_compose
    owner_dir_for_compose=$(get_owner_env_dir)
    if [ -n "$owner_dir_for_compose" ] && [ "$owner_dir_for_compose" != "$SCRIPT_DIR" ] \
       && [ -x "$owner_dir_for_compose/setup-dev-mcp.sh" ]; then
        info "Delegating container creation to the owner project: $owner_dir_for_compose"
        mcp_dir="$owner_dir_for_compose"
    fi

    # Use SKIP_IMAGE_CHECK to avoid re-pulling image (setup-dev-mcp.sh handles this)
    if container_exists "$DEV_MCP_CONTAINER"; then
        warn "Dev MCP container exists but not healthy. Restarting..."
        SKIP_IMAGE_CHECK=true "$mcp_dir/setup-dev-mcp.sh" restart
    else
        log "Creating new Dev MCP container..."
        "$mcp_dir/setup-dev-mcp.sh" start
    fi

    # Wait for health after start/restart
    for i in {1..30}; do
        if check_dev_mcp; then
            log "Dev MCP is ready!"
            return 0
        fi
        echo -ne "${CYAN}[SETUP]${NC} Waiting for Dev MCP... $i/30\r"
        sleep 2
    done
    echo ""
    warn "Dev MCP may not be fully ready yet"
}

# Setup Test MCP container
setup_test_mcp() {
    log "Setting up Test MCP Server..."

    # If already healthy, nothing to do
    if check_test_mcp; then
        info "Test MCP is already running and healthy on port ${TEST_MCP_PORT}"
        info "Skipping creation - reusing existing container"
        return 0
    fi

    # If container is running but not healthy, wait a bit longer before restarting
    if container_running "$TEST_MCP_CONTAINER"; then
        info "Test MCP container running, waiting for health..."
        for i in {1..15}; do
            if check_test_mcp; then
                log "Test MCP is ready!"
                return 0
            fi
            echo -ne "${CYAN}[SETUP]${NC} Waiting for Test MCP health... $i/15\r"
            sleep 2
        done
        echo ""
        warn "Test MCP not responding after wait. Will restart..."
    fi

    # Same ownership rule as the Dev MCP above: test-mcp-compose.yml also mounts
    # the project relative to the directory compose runs in, so a guest running it
    # would re-home the workspace and desync the two containers.
    local test_mcp_dir="$SCRIPT_DIR"
    local owner_dir_for_test
    owner_dir_for_test=$(get_owner_env_dir)
    if [ -n "$owner_dir_for_test" ] && [ "$owner_dir_for_test" != "$SCRIPT_DIR" ] \
       && [ -x "$owner_dir_for_test/setup-test-mcp.sh" ]; then
        info "Delegating Test MCP creation to the owner project: $owner_dir_for_test"
        test_mcp_dir="$owner_dir_for_test"
    fi

    # Use SKIP_IMAGE_CHECK to avoid re-pulling image
    if container_exists "$TEST_MCP_CONTAINER"; then
        warn "Test MCP container exists but not healthy. Restarting..."
        SKIP_IMAGE_CHECK=true "$test_mcp_dir/setup-test-mcp.sh" restart
    else
        log "Creating new Test MCP container..."
        "$test_mcp_dir/setup-test-mcp.sh" start
    fi

    # Wait for health after start/restart
    for i in {1..30}; do
        if check_test_mcp; then
            log "Test MCP is ready!"
            return 0
        fi
        echo -ne "${CYAN}[SETUP]${NC} Waiting for Test MCP... $i/30\r"
        sleep 2
    done
    echo ""
    warn "Test MCP may not be fully ready yet"
}

# Setup database container
setup_database() {
    log "Setting up Database..."

    local requested_db=$(get_db_type)
    local requested_container=$(get_db_container_name "$requested_db")

    # SQLite doesn't need a container
    if [ "$requested_db" = "sqlite" ]; then
        info "SQLite selected - no container needed"
        return 0
    fi

    # Check if the exact database container we need is already running
    if container_running "$requested_container"; then
        info "Database container ($requested_db) is already running"
        info "Skipping creation - reusing existing container"

        # Create the project's database in the existing container
        create_project_database "$requested_db" "$requested_container"
        return 0
    fi

    # Check if a different database type is running
    local running_db=$(get_running_db_container)
    if [ -n "$running_db" ]; then
        warn "A different database ($running_db) is already running"
        warn "Requested database type: $requested_db"

        if [ "$running_db" != "$requested_db" ]; then
            log "Creating additional database container for $requested_db..."
        fi
    fi

    # Create the database container
    if container_exists "$requested_container"; then
        log "Starting existing $requested_db container..."
        docker start "$requested_container"
    else
        log "Creating new $requested_db container..."
        "$SCRIPT_DIR/setup-database.sh" start
    fi

    # Create the project's database
    create_project_database "$requested_db" "$requested_container"
}

# Run init scripts for a database
# Args: $1=db_type $2=container $3=db_name $4=db_user $5=db_pass $6=custom_project_path(optional)
run_init_scripts() {
    local db_type=$1
    local container=$2
    local db_name=$3
    local db_user=$4
    local db_pass=$5
    local custom_project_path=${6:-}

    # Check for init-scripts directory
    local init_scripts_dir=""

    # If custom project path is provided (for additional projects), use that
    if [ -n "$custom_project_path" ] && [ -d "$custom_project_path/init-scripts" ]; then
        init_scripts_dir="$custom_project_path/init-scripts"
    elif [ -d "$PROJECT_ROOT/init-scripts" ] && [ "$(ls -A "$PROJECT_ROOT/init-scripts" 2>/dev/null)" ]; then
        init_scripts_dir="$PROJECT_ROOT/init-scripts"
    elif [ -d "$SCRIPT_DIR/init-scripts" ] && [ "$(ls -A "$SCRIPT_DIR/init-scripts" 2>/dev/null)" ]; then
        init_scripts_dir="$SCRIPT_DIR/init-scripts"
    fi

    if [ -z "$init_scripts_dir" ] || [ ! "$(ls -A "$init_scripts_dir" 2>/dev/null)" ]; then
        info "No init-scripts found for this project"
        return 0
    fi

    log "Running init scripts from: $init_scripts_dir"

    case "$db_type" in
        postgresql|postgres)
            # Run all .sql files in init-scripts
            for script in "$init_scripts_dir"/*.sql; do
                if [ -f "$script" ]; then
                    local script_name=$(basename "$script")
                    log "Executing: $script_name"
                    docker exec -i "$container" psql -U "$db_user" -d "$db_name" < "$script" 2>/dev/null || warn "Script $script_name had warnings/errors"
                fi
            done
            ;;
        mysql|mariadb)
            # Run all .sql files in init-scripts
            for script in "$init_scripts_dir"/*.sql; do
                if [ -f "$script" ]; then
                    local script_name=$(basename "$script")
                    log "Executing: $script_name"
                    docker exec -i "$container" mysql -u"$db_user" -p"$db_pass" "$db_name" < "$script" 2>/dev/null || warn "Script $script_name had warnings/errors"
                fi
            done
            ;;
        mongodb|mongo)
            # Run all .js files in init-scripts
            for script in "$init_scripts_dir"/*.js; do
                if [ -f "$script" ]; then
                    local script_name=$(basename "$script")
                    log "Executing: $script_name"
                    docker exec -i "$container" mongosh -u "$db_user" -p "$db_pass" --authenticationDatabase admin "$db_name" < "$script" 2>/dev/null || warn "Script $script_name had warnings/errors"
                fi
            done
            ;;
        cassandra)
            # Run all .cql files in init-scripts
            for script in "$init_scripts_dir"/*.cql; do
                if [ -f "$script" ]; then
                    local script_name=$(basename "$script")
                    log "Executing: $script_name"
                    docker exec -i "$container" cqlsh -k "$db_name" < "$script" 2>/dev/null || warn "Script $script_name had warnings/errors"
                fi
            done
            ;;
    esac

    log "Init scripts completed"
}

# Run init scripts for an additional project that shares the database container
# This is called when a new project is registered to an existing MCP
# Args: $1=project_path (Windows or Unix path to project root)
run_additional_project_init_scripts() {
    local project_path="$1"

    # Convert Windows path to Unix if needed
    if [[ "$project_path" =~ ^[A-Za-z]: ]]; then
        # Windows path like C:\Users\srima\project2
        project_path="${project_path//\\//}"
        local drive="${project_path:0:1}"
        project_path="/${drive,,}${project_path:2}"
    fi

    # Convert /c/Users/... back to C:/Users/... for local access
    local local_project_path="$project_path"
    if [[ "$project_path" =~ ^/([a-z])/(.*) ]]; then
        local drive_letter="${BASH_REMATCH[1]}"
        local rest="${BASH_REMATCH[2]}"
        local_project_path="${drive_letter^}:/$rest"
    fi

    log "Running init scripts for additional project: $local_project_path"

    # Check if init-scripts exist
    if [ ! -d "$local_project_path/init-scripts" ]; then
        info "No init-scripts directory found for project"
        return 0
    fi

    if [ ! "$(ls -A "$local_project_path/init-scripts" 2>/dev/null)" ]; then
        info "init-scripts directory is empty"
        return 0
    fi

    # Read project's database config
    local project_config="$local_project_path/mcp-server/mcp-config.json"
    if [ ! -f "$project_config" ]; then
        warn "No mcp-config.json found for project. Cannot determine database settings."
        return 1
    fi

    local db_type=""
    local db_name=""
    local db_user=""
    local db_pass=""

    if command -v jq &> /dev/null; then
        db_type=$(jq -r '.databaseConfig.type // "postgresql"' "$project_config" 2>/dev/null)
        db_name=$(jq -r '.databaseConfig.database // "appdb"' "$project_config" 2>/dev/null)
        db_user=$(jq -r '.databaseConfig.username // "appuser"' "$project_config" 2>/dev/null)
        db_pass=$(jq -r '.databaseConfig.password // "apppassword"' "$project_config" 2>/dev/null)
    else
        warn "jq not installed. Using default database settings."
        db_type="postgresql"
        db_name="appdb"
        db_user="appuser"
        db_pass="apppassword"
    fi

    # Get the database container name
    local container=$(get_db_container_name "$db_type")

    # Check if container is running
    if ! container_running "$container"; then
        warn "Database container '$container' is not running. Cannot run init scripts."
        return 1
    fi

    log "Database type: $db_type, Database: $db_name, Container: $container"

    # First, ensure the project's database exists
    case "$db_type" in
        postgresql|postgres)
            if ! docker exec "$container" psql -U "$db_user" -tc \
                "SELECT 1 FROM pg_database WHERE datname = '$db_name'" 2>/dev/null | grep -q 1; then
                log "Creating database '$db_name' for additional project..."
                docker exec "$container" psql -U "$db_user" -c \
                    "CREATE DATABASE \"$db_name\"" 2>/dev/null || warn "Database may already exist"
            fi
            ;;
        mysql|mariadb)
            docker exec "$container" mysql -u"$db_user" -p"$db_pass" -e \
                "CREATE DATABASE IF NOT EXISTS \`$db_name\`" 2>/dev/null || true
            ;;
    esac

    # Run init scripts from the project's init-scripts directory
    run_init_scripts "$db_type" "$container" "$db_name" "$db_user" "$db_pass" "$local_project_path"

    log "Additional project database initialized successfully!"
}

# Create project-specific database in existing container
create_project_database() {
    local db_type=$1
    local container=$2

    # Read database config
    local db_name="appdb"
    local db_user="appuser"
    local db_pass="apppassword"

    if [ -f "$CONFIG_FILE" ]; then
        if command -v jq &> /dev/null; then
            db_name=$(jq -r '.databaseConfig.database // "appdb"' "$CONFIG_FILE" 2>/dev/null)
            db_user=$(jq -r '.databaseConfig.username // "appuser"' "$CONFIG_FILE" 2>/dev/null)
            db_pass=$(jq -r '.databaseConfig.password // "apppassword"' "$CONFIG_FILE" 2>/dev/null)
        fi
    fi

    log "Ensuring database '$db_name' exists for project '$PROJECT_NAME'..."

    local db_created=false

    case "$db_type" in
        postgresql|postgres)
            # Check if database exists
            if docker exec "$container" psql -U "$db_user" -tc \
                "SELECT 1 FROM pg_database WHERE datname = '$db_name'" 2>/dev/null | grep -q 1; then
                info "Database '$db_name' already exists"
            else
                # Create database
                log "Creating database '$db_name'..."
                docker exec "$container" psql -U "$db_user" -c \
                    "CREATE DATABASE \"$db_name\"" 2>/dev/null || true
                db_created=true
            fi
            ;;
        mysql|mariadb)
            docker exec "$container" mysql -u"$db_user" -p"$db_pass" -e \
                "CREATE DATABASE IF NOT EXISTS \`$db_name\`" 2>/dev/null || true
            ;;
        mongodb|mongo)
            # MongoDB creates databases automatically
            info "MongoDB will create database '$db_name' on first use"
            ;;
        redis)
            # Redis doesn't have database creation like SQL
            info "Redis is ready for use"
            ;;
        cassandra)
            # Create keyspace
            docker exec "$container" cqlsh -e \
                "CREATE KEYSPACE IF NOT EXISTS $db_name WITH replication = {'class': 'SimpleStrategy', 'replication_factor': 1}" 2>/dev/null || true
            ;;
        dynamodb)
            # DynamoDB tables are created by the application
            info "DynamoDB Local is ready for use"
            ;;
    esac

    # Run init scripts (for new databases or when --force is used)
    if [ "$db_created" = "true" ] || [ "${FORCE_INIT_SCRIPTS:-false}" = "true" ]; then
        run_init_scripts "$db_type" "$container" "$db_name" "$db_user" "$db_pass"
    fi
}

# Register project with MCP
# Args: $1 = "owner" if this is the first project that created containers
register_project() {
    local is_owner="${1:-false}"

    log "Registering project with MCP Server..."

    # Wait for MCP to be healthy with retries
    local max_retries=75   # ~150s: tolerate >1min cold starts during self-heal
    local retry_count=0
    while ! check_dev_mcp; do
        retry_count=$((retry_count + 1))
        if [ $retry_count -ge $max_retries ]; then
            error "Dev MCP is not running after $max_retries attempts. Cannot register project."
            warn "You can manually register at: http://localhost:${DEV_MCP_PORT}/projects"
            return 1
        fi
        echo -ne "${CYAN}[SETUP]${NC} Waiting for Dev MCP to be ready for registration... $retry_count/$max_retries\r"
        sleep 2
    done
    echo ""
    log "Dev MCP is ready for registration"

    # Get project info from mcp-config.json
    local project_id=""
    local db_name=""
    local db_type=""
    local api_key=""
    local sprint_id=""
    local db_config=""
    local api_url=""
    local environment=""
    local expires_at=""
    if [ -f "$CONFIG_FILE" ]; then
        if command -v jq &> /dev/null; then
            project_id=$(jq -r '.projectId // ""' "$CONFIG_FILE" 2>/dev/null)
            db_name=$(jq -r '.databaseConfig.database // ""' "$CONFIG_FILE" 2>/dev/null)
            db_type=$(jq -r '.databaseConfig.type // ""' "$CONFIG_FILE" 2>/dev/null)
            # Extract API key for multi-project credential routing (critical for 401 fix)
            api_key=$(jq -r '.encryptedPlatformApiKey // .sessionToken // ""' "$CONFIG_FILE" 2>/dev/null)
            sprint_id=$(jq -r '.sprintId // ""' "$CONFIG_FILE" 2>/dev/null)
            # Get full database config as JSON string
            db_config=$(jq -c '.databaseConfig // {}' "$CONFIG_FILE" 2>/dev/null)
            # Per-project environment routing (dev/staging/prod own URL + expiry)
            api_url=$(jq -r '.apiUrl // .platformApiUrl // ""' "$CONFIG_FILE" 2>/dev/null)
            environment=$(jq -r '.environment // .activeEnvironment // "prod"' "$CONFIG_FILE" 2>/dev/null)
            expires_at=$(jq -r '.expiresAt // ""' "$CONFIG_FILE" 2>/dev/null)
        fi
    fi

    if [ -z "$project_id" ]; then
        error "Cannot register: no projectId found in $CONFIG_FILE."
        error "A valid project UUID is required (do NOT register under a folder name)."
        return 1
    fi

    # Convert paths to Unix format for Docker compatibility
    local unix_project_path=$(get_unix_project_path)

    # Guard: a guest must never register under the OWNER's projectId (mis-set
    # mcp-config.json). The server also rejects this (400), but fail early + clearly.
    if [ "$is_owner" != "true" ] && command -v jq &> /dev/null; then
        local projects_json owner_id owner_path owner_path_norm unix_project_path_cmp
        projects_json=$(curl -sf "http://localhost:${DEV_MCP_PORT}/api/projects" 2>/dev/null || echo "")
        owner_id=$(echo "$projects_json" | jq -r '.projects[]? | select(.isOwner==true) | .projectId' 2>/dev/null | head -1)
        owner_path=$(echo "$projects_json" | jq -r '.projects[]? | select(.isOwner==true) | .projectPath' 2>/dev/null | head -1)
        # Normalize BOTH sides to the same Unix form before comparing. The Dev MCP
        # self-registers the owner with a Windows-style path (C:/Users/...), while
        # unix_project_path is /c/Users/...; a raw string compare falsely flags the
        # owner as a mismatched guest ("path differs") even though it is the same
        # directory. to_unix_path handles C:\..., C:/..., and already-Unix paths;
        # trailing slashes are stripped so /path and /path/ compare equal.
        owner_path_norm="$(to_unix_path "${owner_path%/}")"
        unix_project_path_cmp="${unix_project_path%/}"
        if [ -n "$owner_id" ] && [ "$owner_id" = "$project_id" ] && [ "$owner_path_norm" != "$unix_project_path_cmp" ]; then
            error "This project's id ($project_id) is the OWNER's id, but the path differs"
            error "($unix_project_path vs owner $owner_path). A guest cannot register under the"
            error "owner's id — fix this project's mcp-config.json / .projexlight/config.json projectId."
            return 1
        fi
    fi

    log "Registering with Unix path: $unix_project_path"
    if [ -n "$api_key" ]; then
        log "  API key: [present]"
    else
        warn "  API key: [missing] - API calls may fail with 401"
    fi

    # Try to register via API
    # If this is the owner project (first to create containers), mark it as such
    # IMPORTANT: Pass apiKey for multi-project credential routing
    # NOTE: plain `-s` (not `-sf`) so we capture the server's error body (e.g. the
    # 400 owner-id / project-limit messages) instead of swallowing it.
    local register_response
    register_response=$(curl -s -X POST "http://localhost:${DEV_MCP_PORT}/api/projects/register" \
        -H "Content-Type: application/json" \
        -d "{
            \"projectId\": \"$project_id\",
            \"projectName\": \"$PROJECT_NAME\",
            \"projectPath\": \"$unix_project_path\",
            \"workspacePath\": \"$unix_project_path\",
            \"databaseName\": \"$db_name\",
            \"databaseType\": \"$db_type\",
            \"apiKey\": \"$api_key\",
            \"apiUrl\": \"$api_url\",
            \"environment\": \"$environment\",
            \"expiresAt\": \"$expires_at\",
            \"sprintId\": \"$sprint_id\",
            \"databaseConfig\": $db_config,
            \"isOwner\": $is_owner
        }" 2>&1) || true

    # Verify the registration actually landed by reading it back — do NOT trust the
    # POST response alone (handles the health-before-registry-ready race + silent
    # failures). This is the fix for "registered but not really in the owner registry".
    if verify_project_registered "$project_id"; then
        if [ "$is_owner" = "true" ]; then
            log "Project registered as OWNER and verified in registry"
        else
            log "Project registered and verified in registry"
        fi
        info "Unix path: $unix_project_path"
        return 0
    else
        error "Registration could NOT be verified for project $project_id"
        info "Server response: $register_response"
        info "Register manually at: http://localhost:${DEV_MCP_PORT}/projects (Unix path: $unix_project_path)"
        return 1
    fi
}

# Install git hooks
install_hooks() {
    log "Installing git hooks..."

    # Check if we're in a git repo
    if [ ! -d "$PROJECT_ROOT/.git" ]; then
        warn "Not a git repository. Skipping hook installation."
        return 0
    fi

    local hooks_dir="$PROJECT_ROOT/.git/hooks"
    mkdir -p "$hooks_dir"

    # Install pre-commit hook
    if [ -f "$SCRIPT_DIR/templates/pre-commit" ]; then
        cp "$SCRIPT_DIR/templates/pre-commit" "$hooks_dir/pre-commit"
        chmod +x "$hooks_dir/pre-commit"

        # NOTE: Do NOT sed-replace PROJECT_ROOT in the hook.
        # The template already handles dynamic detection (Docker vs host)
        # via if/else logic. Replacing all PROJECT_ROOT= lines destroys
        # that conditional and hardcodes the wrong path for multi-project setups.

        log "Installed pre-commit hook"
    fi

    # Install pre-push hook
    if [ -f "$SCRIPT_DIR/templates/pre-push" ]; then
        cp "$SCRIPT_DIR/templates/pre-push" "$hooks_dir/pre-push"
        chmod +x "$hooks_dir/pre-push"
        log "Installed pre-push hook"
    fi

    log "Git hooks installed successfully"
}

# Show status of all containers
show_status() {
    print_header

    echo -e "${BLUE}Container Status:${NC}"
    echo ""

    # Dev MCP
    echo -n "  Dev MCP ($DEV_MCP_CONTAINER): "
    if check_dev_mcp; then
        echo -e "${GREEN}Running${NC} - http://localhost:${DEV_MCP_PORT}"
    elif container_exists "$DEV_MCP_CONTAINER"; then
        echo -e "${YELLOW}Stopped${NC}"
    else
        echo -e "${RED}Not Created${NC}"
    fi

    # Test MCP
    echo -n "  Test MCP ($TEST_MCP_CONTAINER): "
    if check_test_mcp; then
        echo -e "${GREEN}Running${NC} - http://localhost:${TEST_MCP_PORT}"
    elif container_exists "$TEST_MCP_CONTAINER"; then
        echo -e "${YELLOW}Stopped${NC}"
    else
        echo -e "${RED}Not Created${NC}"
    fi

    # Database containers
    echo ""
    echo -e "${BLUE}Database Containers:${NC}"
    for db_type in postgresql mysql mariadb mongodb redis cassandra dynamodb; do
        local container=$(get_db_container_name "$db_type")
        if container_running "$container"; then
            echo -e "  $db_type: ${GREEN}Running${NC}"
        elif container_exists "$container"; then
            echo -e "  $db_type: ${YELLOW}Stopped${NC}"
        fi
    done

    # Project info
    echo ""
    echo -e "${BLUE}Current Project:${NC}"
    echo "  Name: $PROJECT_NAME"
    echo "  Path: $PROJECT_ROOT"
    echo "  Unix Path: $(get_unix_project_path)"
    if [ -f "$CONFIG_FILE" ]; then
        local db_type=$(get_db_type)
        local db_name=""
        if command -v jq &> /dev/null; then
            db_name=$(jq -r '.databaseConfig.database // ""' "$CONFIG_FILE" 2>/dev/null)
        fi
        echo "  Database Type: $db_type"
        [ -n "$db_name" ] && echo "  Database Name: $db_name"
    fi

    echo ""
}

# Force restart all containers
force_restart() {
    warn "Force restarting all containers..."

    "$SCRIPT_DIR/setup-dev-mcp.sh" restart 2>/dev/null || true
    "$SCRIPT_DIR/setup-test-mcp.sh" restart 2>/dev/null || true
    "$SCRIPT_DIR/setup-database.sh" restart 2>/dev/null || true

    log "All containers restarted"
}

#===============================================================================
# .env Recovery from registered_projects.json
#===============================================================================
# When Docker restarts, the container is recreated from docker-compose + .env.
# If additional projects were registered but their ADDITIONAL_PROJECT_N entries
# are missing from .env, their volumes won't be mounted and tools will fail.
#
# This function reads the shared registry (~/.projexlight/registered_projects.json)
# and rebuilds all ADDITIONAL_PROJECT_N + PROJECT_PATH_MAPPINGS entries in the
# owner's .env BEFORE docker-compose up runs.

recover_env_from_registry() {
    # Target dir = where the OWNER's .env + registry live (the .env the container
    # actually reads). Defaults to the owner's mcp-server dir so a GUEST running
    # setup-all updates the OWNER's .env — not its own (the previous bug). Callers
    # may override (promote-self passes "$SCRIPT_DIR" after snapshotting the registry
    # there so THIS project becomes the new owner).
    local target_dir="${1:-}"
    [ -z "$target_dir" ] && target_dir="$(get_owner_env_dir)"
    [ -z "$target_dir" ] && target_dir="$SCRIPT_DIR"
    # The registry is now the single shared file in ~/.projexlight; the owner's
    # .env (read by BOTH the Dev and Test compose) is still where mounts are emitted.
    local reg_file="$REGISTRY_FILE"
    local env_file="$target_dir/.env"

    if [ ! -f "$reg_file" ] || [ ! -f "$env_file" ]; then
        return 0  # Nothing to recover
    fi

    if ! command -v jq &> /dev/null; then
        warn "jq not available - cannot recover .env from registry"
        return 0
    fi

    # Strategy: the registry is the single source of truth. Delete EVERY
    # multi-project entry from .env (all ADDITIONAL_PROJECT_N lines, their
    # comment headers, and PROJECT_PATH_MAPPINGS), then re-emit them fresh
    # from the registry. This avoids every class of accumulated drift:
    # stale slot numbers, duplicate keys in PROJECT_PATH_MAPPINGS, orphan
    # ADDITIONAL_PROJECT_N from prior slot assignments, CRLF corruption of
    # previous sed operations, etc. Running this function is idempotent —
    # if .env already matches the registry, the file ends up identical.

    # Step 0: last-known-good backup of the owner .env before ANY rewrite.
    # This function is on the default (no-argument) setup path, so it runs on
    # essentially every invocation — the backup is a single rolling file rather
    # than a timestamped one so repeated runs cannot litter the directory.
    # It is only refreshed from a .env that still looks sane, so a corrupt file
    # can never overwrite a good backup.
    local env_backup="${env_file}.bak"
    if [ -s "$env_file" ] && grep -qE '^[A-Za-z_][A-Za-z0-9_]*=' "$env_file" 2>/dev/null; then
        cp "$env_file" "$env_backup" 2>/dev/null || true
    fi

    # Everything that is NOT a derived multi-project line must survive the rebuild.
    # Captured up front so the result can be verified before the new file is kept.
    local preserved_before
    preserved_before=$(grep -E '^[A-Za-z_][A-Za-z0-9_]*=' "$env_file" 2>/dev/null \
        | grep -cvE '^(PROJECT_PATH_MAPPINGS|ADDITIONAL_PROJECT_[0-9]+|PROJEX_REGISTRY_DIR_HOST)=' \
        | tr -d '[:space:]')
    preserved_before=${preserved_before:-0}

    local tmp
    tmp=$(mktemp "${TMPDIR:-/tmp}/env_rebuild.XXXXXX")

    # Step 1: strip all multi-project entries (data lines AND their
    # comment headers) from .env. Non-multi-project content is preserved.
    # The mv is guarded on a NON-EMPTY result: a failed/interrupted awk that
    # produced an empty file would otherwise truncate the owner's .env, taking
    # MCP_ENCRYPTION_KEY with it and breaking every project on this machine.
    if awk '
        /^ADDITIONAL_PROJECT_[0-9]+=/                   { next }
        /^# *Additional project [0-9]+ volume mount/    { next }
        /^PROJECT_PATH_MAPPINGS=/                       { next }
        /^# *Multi-project path mappings/               { next }
        /^# *Shared project registry host dir/          { next }
        { print }
    ' "$env_file" > "$tmp" 2>/dev/null && [ -s "$tmp" ]; then
        mv "$tmp" "$env_file"
    else
        rm -f "$tmp"
        warn "Could not rewrite $env_file safely - leaving it untouched"
        return 0
    fi

    # Step 2: collapse runs of blank lines created by the strip.
    tmp=$(mktemp "${TMPDIR:-/tmp}/env_rebuild.XXXXXX")
    if awk 'NR==1{p=$0; print; next} !(p=="" && $0==""){print; p=$0}' \
        "$env_file" > "$tmp" 2>/dev/null && [ -s "$tmp" ]; then
        mv "$tmp" "$env_file"
    else
        rm -f "$tmp"
    fi

    # Step 2b: assign container slots to any guest that is registered but has no
    # usable containerPath.
    #
    # A project registered through the MCP API (/api/projects/register) gets a
    # registry row but no slot — the API cannot add a Docker bind mount to a
    # running container, so it leaves containerPath "". Without this step that
    # project stays invisible forever: it is registered, but has no mount and no
    # valid mapping. Assigning here — inside the one function that regenerates
    # from the registry — makes the whole thing self-healing.
    #
    # NOTE: slot paths are built INSIDE jq from a numeric --arg. Passing
    # "/projects/additionalN" as a jq argument would be rewritten by Git Bash/MSYS
    # path conversion into "C:/Program Files/Git/projects/additionalN".
    # The assignment runs as ONE jq program over the whole registry rather than a
    # shell loop issuing one jq write per project. A per-project loop is unsafe
    # here: an empty element in the id list makes `.[$k].containerPath = ...`
    # CREATE a new "" key instead of updating an existing one, which silently
    # corrupts the registry and emits ADDITIONAL_PROJECT_N=null downstream.
    # A single pass also cannot lose an earlier write to a later read.
    local slots_before slots_after rtmp
    slots_before=$(jq -r '[ .[] | select((.containerPath // "") | test("^/projects/additional([1-9]|10)$")) ] | length' \
                      "$reg_file" 2>/dev/null || echo 0)

    rtmp=$(mktemp "${TMPDIR:-/tmp}/registry_slot.XXXXXX")
    if jq '
        def is_slot: test("^/projects/additional([1-9]|10)$");
        def slot_of: capture("^/projects/additional(?<n>[1-9]|10)$").n | tonumber;
        def norm_path: (. // "") | sub("/+$"; "");

        # Winners: the most recent registration per distinct guest FOLDER.
        # Re-running setup cannot duplicate a project (the registry is an object
        # keyed by projectId, so a re-register overwrites in place), but a folder
        # re-exported under a NEW projectId leaves the old id behind. Both entries
        # then claim a slot for the same directory — mounting it twice and wasting
        # one of only three slots, while PROJECT_PATH_MAPPINGS (keyed by path)
        # silently collapses to whichever was written last.
        ([ to_entries[] | select(.value.isOwner != true) ]
         | group_by(.value.projectPath | norm_path)
         | map(sort_by(.value.registeredAt // "") | last | .key)) as $winners

        # Release slots held by superseded duplicates so the capacity comes back.
        # NOTE: the key is bound to $k first. Writing `$winners | index(.key)`
        # evaluates .key against the ARRAY, not the entry ("Cannot index array").
        | reduce ( to_entries[]
                   | select(.value.isOwner != true)
                   | .key as $k
                   | select(($winners | index($k)) == null)
                   | $k ) as $dup (. ; .[$dup].containerPath = "")

        # Slots already held keep their assignment so existing mounts stay stable.
        | [ .[] | (.containerPath // "") | select(is_slot) | slot_of ] as $taken
        # Winners still lacking a usable slot, oldest registration first so
        # assignment is deterministic. The whole expression is parenthesised so the
        # binding does not consume the pipeline: without the parens the reduce below
        # would receive the array of keys as its input instead of the registry.
        | ([ to_entries[]
             | select(.value.isOwner != true)
             | select(.key as $k | ($winners | index($k)) != null)
             | select(((.value.containerPath // "") | is_slot) | not) ]
           | sort_by(.value.registeredAt // "")
           | map(.key)) as $pending
        | reduce range(0; ($pending | length)) as $i
            ({ reg: ., taken: $taken };
             ([ range(1; 11) ] - .taken | sort | first) as $free
             | if $free == null then .          # out of slots: leave untouched
               else .reg[$pending[$i]].containerPath = ("/projects/additional" + ($free | tostring))
                    | .taken += [$free]
                    | .
               end)
        | .reg
    ' "$reg_file" > "$rtmp" 2>/dev/null && [ -s "$rtmp" ] && jq -e . "$rtmp" >/dev/null 2>&1; then
        # Rolling last-known-good copy before replacing the shared registry. The
        # jq -e above already proved the replacement is valid JSON, so this can
        # never archive a corrupt file over a good one.
        cp "$reg_file" "${reg_file}.bak" 2>/dev/null || true
        mv "$rtmp" "$reg_file"
        slots_after=$(jq -r '[ .[] | select((.containerPath // "") | test("^/projects/additional([1-9]|10)$")) ] | length' \
                         "$reg_file" 2>/dev/null || echo 0)
        if [ "$slots_after" -gt "$slots_before" ]; then
            log "Assigned container slots to $((slots_after - slots_before)) newly registered project(s)"
        fi
        # Genuinely unplaceable projects only. A superseded duplicate (same folder,
        # older projectId) intentionally has its slot released and must NOT be
        # reported as "out of slots" — that warning would fire on every run and
        # tell the user to unregister something when nothing is actually wrong.
        local still_pending
        still_pending=$(jq -r '
            [ .[]
              | select((.containerPath // "") | test("^/projects/additional([1-9]|10)$"))
              | (.projectPath // "") | sub("/+$"; "") ] as $served
            | [ to_entries[]
                | select(.value.isOwner != true)
                | select(((.value.containerPath // "") | test("^/projects/additional([1-9]|10)$")) | not)
                | ((.value.projectPath // "") | sub("/+$"; "")) as $p
                | select(($served | index($p)) == null) ]
            | length' "$reg_file" 2>/dev/null || echo 0)
        if [ "$still_pending" -gt 0 ]; then
            warn "$still_pending registered project(s) could not be given a container slot (max 3)."
            warn "Unregister one at http://localhost:${DEV_MCP_PORT}/projects to free a slot."
        fi
    else
        rm -f "$rtmp"
        warn "Could not assign container slots in the registry - continuing with existing values"
    fi

    # Step 3: rebuild PROJECT_PATH_MAPPINGS from every registered project
    # (both owner and additional). jq produces deterministic, valid JSON
    # with no duplicate keys.
    #
    # The emptiness test is explicit: in jq only null and false are falsy, so a
    # bare `select(.value.containerPath)` ACCEPTS "" and emits a mapping entry
    # pointing at nothing. That mismatch against the startswith() filter used for
    # ADDITIONAL_PROJECT_N below is what produced entries like
    # {"/c/Users/srima/projex_crm": ""} with no corresponding mount.
    local fresh_mappings
    fresh_mappings=$(jq -r '
        to_entries
        | map(select(((.value.containerPath // "") != "") and ((.value.projectPath // "") != "")))
        | map({(.value.projectPath): .value.containerPath})
        | add
        | if . == null then {} else . end
        | tojson
    ' "$reg_file" 2>/dev/null) || fresh_mappings='{}'

    {
        echo ""
        echo "# Multi-project path mappings (JSON) — regenerated from registry"
        echo "PROJECT_PATH_MAPPINGS='${fresh_mappings:-\{\}}'"
    } >> "$env_file"

    # Step 4: re-emit ADDITIONAL_PROJECT_N entries for every non-owner
    # project whose containerPath is /projects/additionalN. The registry's
    # isOwner flag is authoritative — we do NOT fall back to a path match
    # with the caller's own project path (that was the original bug).
    local additional_projects
    additional_projects=$(jq -r '
        to_entries[]
        | select(.value.isOwner != true)
        | select(.value.containerPath | startswith("/projects/additional"))
        | "\(.value.containerPath | ltrimstr("/projects/additional"))|\(.value.projectPath)"
    ' "$reg_file" 2>/dev/null) || fresh_mappings='{}'

    local emitted=0
    if [ -n "$additional_projects" ]; then
        while IFS='|' read -r slot unix_path; do
            [ -z "$slot" ] || [ -z "$unix_path" ] && continue

            # Convert Unix path to Windows path for Docker volume mount.
            local windows_path="$unix_path"
            if [[ "$unix_path" =~ ^/([a-z])/(.*) ]]; then
                local drive="${BASH_REMATCH[1]}"
                local rest="${BASH_REMATCH[2]}"
                windows_path="${drive^}:/$rest"
            fi

            {
                echo ""
                echo "# Additional project $slot volume mount"
                echo "ADDITIONAL_PROJECT_${slot}=$windows_path"
            } >> "$env_file"
            emitted=$((emitted + 1))
        done <<< "$additional_projects"
    fi

    # The registry pointer must live in the OWNER's .env — that is the file the
    # compose stack reads. ensure_registry_env defaults to $SCRIPT_DIR/.env, so a
    # guest running setup-all would otherwise write it only into its own .env and
    # the container would silently fall back to the 'projex_registry' named volume
    # (compose default). That fallback is a DIFFERENT file from ~/.projexlight, so
    # every guest registration written here would be invisible to the container.
    ensure_registry_env "$env_file"

    # Final integrity gate. Everything that was not a derived multi-project line
    # (MCP_ENCRYPTION_KEY, PROJEXLIGHT_API_URL, ports, ...) must still be present.
    # If the rebuild dropped any of it, restore the last-known-good copy rather
    # than leaving a half-written .env — a truncated owner .env breaks every
    # project sharing these containers, not just this one.
    local preserved_after
    preserved_after=$(grep -E '^[A-Za-z_][A-Za-z0-9_]*=' "$env_file" 2>/dev/null \
        | grep -cvE '^(PROJECT_PATH_MAPPINGS|ADDITIONAL_PROJECT_[0-9]+|PROJEX_REGISTRY_DIR_HOST)=' \
        | tr -d '[:space:]')
    preserved_after=${preserved_after:-0}

    if [ "$preserved_after" -lt "$preserved_before" ]; then
        if [ -s "$env_backup" ]; then
            cp "$env_backup" "$env_file" 2>/dev/null || true
            error "Rebuild would have dropped $((preserved_before - preserved_after)) setting(s) from $env_file"
            error "Restored the previous version from $env_backup - no changes applied."
        else
            error "Rebuild dropped settings from $env_file and no backup was available."
        fi
        return 1
    fi

    log "Rebuilt multi-project .env from registry (${emitted} additional slot(s))"
}

# Re-derive .env from the registry (single source of truth) and recreate the MCP
# containers so newly registered projects get mounted and the in-memory registry
# is reloaded. Called AFTER registration so the new entry is included.
reload_containers_from_registry() {
    recover_env_from_registry
    ensure_run_as_env
    local owner_dir; owner_dir=$(get_owner_env_dir)
    if [ -z "$owner_dir" ]; then
        warn "Owner dir not found; cannot reload containers from registry"
        return 1
    fi
    local cf; cf=$(docker inspect "$DEV_MCP_CONTAINER" \
        --format='{{index .Config.Labels "com.docker.compose.project.config_files"}}' 2>/dev/null || echo "")
    cf="${cf//\\//}"
    if [ -n "$cf" ] && [ -f "$cf" ]; then
        log "Reloading MCP containers from registry: $(basename "$cf")"
        (cd "$owner_dir" && docker compose -f "$(basename "$cf")" up -d 2>/dev/null) || \
        (cd "$owner_dir" && docker-compose -f "$(basename "$cf")" up -d 2>/dev/null) || \
            { warn "Could not reload containers automatically"; return 1; }
    else
        warn "Compose file not found for $DEV_MCP_CONTAINER; reload containers manually"
        return 1
    fi
    return 0
}

# Verify a project actually landed in the owner registry by reading it back from
# the live server. Handles the "/health 200 before registry ready" race and silent
# POST failures. Returns 0 if the projectId is present, 1 otherwise.
verify_project_registered() {
    local pid="$1" attempt
    [ -z "$pid" ] && return 1
    command -v jq &> /dev/null || return 0  # cannot verify without jq; don't block
    for attempt in $(seq 1 10); do
        if curl -sf "http://localhost:${DEV_MCP_PORT}/api/projects" 2>/dev/null \
             | jq -e --arg pid "$pid" '.projects[]? | select(.projectId==$pid)' >/dev/null 2>&1; then
            return 0
        fi
        sleep 2
    done
    return 1
}

# Is the currently-registered owner's project folder still present on disk?
# Returns 0 (alive / unknown / no-owner) or 1 (owner registered but folder GONE).
# Used to decide whether THIS project should promote itself to owner.
is_owner_folder_alive() {
    command -v jq &> /dev/null || return 0   # can't check → assume alive
    local pj owner_path
    pj=$(curl -sf "http://localhost:${DEV_MCP_PORT}/api/projects" 2>/dev/null || echo "")
    owner_path=$(echo "$pj" | jq -r '.projects[]? | select(.isOwner==true) | .projectPath' 2>/dev/null | head -1)
    [ -z "$owner_path" ] && return 0         # no owner registered → first-owner flow handles it
    [ -d "$owner_path" ] && return 0         # folder present → alive
    return 1                                  # owner registered but folder gone
}

#===============================================================================
# Main Setup Flow
#===============================================================================

run_setup() {
    print_header

    log "Project: $PROJECT_NAME"
    log "Path: $PROJECT_ROOT"
    log "Unix Path: $(get_unix_project_path)"
    echo ""

    check_prerequisites
    echo ""

    # Recover .env from registered_projects.json (survives Docker restarts)
    # This must run BEFORE containers start so volume mounts are correct
    recover_env_from_registry
    ensure_run_as_env
    echo ""

    # Determine if this is the first project
    if is_first_project; then
        log "First project setup - creating all containers"
        echo ""

        # IMPORTANT: Create local registration BEFORE starting containers
        # This sets PROJECT_PATH_MAPPINGS in .env so containers get correct mounts
        if ! is_project_registered; then
            create_local_registration "true"
            echo ""
        else
            info "Project already registered locally"
        fi

        # Full setup
        setup_database
        echo ""
        setup_dev_mcp
        echo ""
        setup_test_mcp
        echo ""
        install_hooks
        echo ""

        # First project auto-registers as OWNER via API (cannot be removed)
        log "Auto-registering first project as OWNER via API..."
        if ! register_project "true"; then
            warn "Owner registration could not be verified — check the Dev MCP logs."
            warn "Re-run ./setup-all.sh once the Dev MCP is fully ready."
        fi

        # Auto-fix credential mismatches after registration
        echo ""
        log "Checking credential sync..."
        auto_fix_credentials
    else
        log "Existing MCP detected - reusing containers"
        echo ""

        # Ensure the shared MCP containers are up. Do NOT pre-write .env here — the
        # guest's mount is derived from registered_projects.json by
        # recover_env_from_registry AFTER it is registered below, so the registry
        # stays the single source of truth (no hand-written entries in the owner .env).
        if ! check_dev_mcp || ! check_test_mcp; then
            warn "Containers not healthy - restarting..."
            "$SCRIPT_DIR/setup-dev-mcp.sh" restart 2>/dev/null || true
            "$SCRIPT_DIR/setup-test-mcp.sh" restart 2>/dev/null || true
            echo ""
        else
            info "Containers are already running and healthy"
        fi

        # Check and setup database (may need different type)
        setup_database
        echo ""

        # Check MCP containers (will wait for health, won't restart if healthy)
        setup_dev_mcp
        echo ""
        setup_test_mcp
        echo ""

        # Install hooks
        install_hooks
        echo ""

        info "MCP containers are shared with other projects"
        echo ""

        if is_owner_folder_alive; then
            # Normal guest path: register in the owner registry (read-back verified),
            # then re-derive .env from the registry and reload so the guest mounts on
            # THIS run. The server enforces the max-project limit (HTTP 400).
            if ! register_project "false"; then
                error "Guest registration failed/unverified — NOT marking setup complete."
                error "If this is a project-slot limit, free one at http://localhost:${DEV_MCP_PORT}/projects, then re-run."
                error "Otherwise fix the issue above (wrong projectId / expired key) and re-run ./setup-all.sh."
                exit 1
            fi
            reload_containers_from_registry || warn "Container reload incomplete — re-run ./setup-all.sh."
        else
            # SELF-HEAL / promote-self: the registered owner's FOLDER is gone (owner
            # deleted). The old owner's compose no longer exists, so recreate FROM THIS
            # project so /workspace re-homes here; the server's startup reconciler then
            # evicts the dead owner and marks THIS project owner.
            warn "Registered owner folder is missing — self-healing: promoting THIS project to owner..."

            # The shared registry in ~/.projexlight already holds the whole fleet
            # and SURVIVES owner deletion (it no longer lives inside the owner's
            # folder), so no snapshot-via-API dance is needed. Just rebuild THIS
            # project's .env from the shared registry, drop the stale containers
            # (launched from the deleted owner; the fixed container_name would
            # clash), and recreate FROM THIS project via the canonical wrappers.
            recover_env_from_registry "$SCRIPT_DIR"
            docker rm -f "$DEV_MCP_CONTAINER" 2>/dev/null || true
            docker rm -f "$TEST_MCP_CONTAINER" 2>/dev/null || true
            setup_dev_mcp
            setup_test_mcp
            if ! register_project "true"; then
                error "Self-heal FAILED: could not register THIS project as the new owner."
                error "The current project's own token may be expired — refresh its CLI export"
                error "(ProjexLight Portal > project > CLI Export) and re-run ./setup-all.sh."
                exit 1
            fi
        fi
    fi

    # Auto-fix credential mismatches (checks config vs registered)
    echo ""
    log "Checking credential sync..."
    auto_fix_credentials

    # Final status
    echo ""
    echo -e "${GREEN}═══════════════════════════════════════════════════════════════${NC}"
    echo -e "${GREEN}   Setup Complete!${NC}"
    echo -e "${GREEN}═══════════════════════════════════════════════════════════════${NC}"
    echo ""
    echo "  Dev MCP:    http://localhost:${DEV_MCP_PORT}"
    echo "  Test MCP:   http://localhost:${TEST_MCP_PORT}"
    echo "  Projects:   http://localhost:${DEV_MCP_PORT}/projects"
    echo ""
    echo "  Git hooks have been installed. Pre-commit scan is active."
    echo ""
}

#===============================================================================
# Command Line Handling
#===============================================================================

show_usage() {
    echo ""
    echo "ProjexLight Multi-Project Setup"
    echo "================================"
    echo ""
    echo "Usage: $0 [option]"
    echo ""
    echo "Options:"
    echo "  (no option)       Interactive setup (creates containers if needed)"
    echo "  --status          Show status of all containers"
    echo "  --register        Register this project with existing MCP"
    echo "  --sync-creds      Sync credentials from mcp-config.json (auto-fix 401 errors)"
    echo "  --install-hooks   Install git hooks only"
    echo "  --init-scripts    Run init-scripts on existing database"
    echo "  --migrate [path]  Run database migration for a project"
    echo "                    If path is omitted, migrates current project"
    echo "  --force           Force restart all containers"
    echo "  --help            Show this help"
    echo ""
    echo "Multi-Project Architecture:"
    echo "  - First project creates all containers"
    echo "  - Subsequent projects reuse existing containers"
    echo "  - Each project gets its own database within shared container"
    echo "  - Projects with same DB type share the same container"
    echo "  - Projects are registered via UI at http://localhost:8766/projects"
    echo ""
    echo "Environment Variables:"
    echo "  PROJEXLIGHT_API_URL  - API server URL (default: https://api.projexlight.com)"
    echo "                         Set in .env file or export before running"
    echo ""
    echo "Database Migration Examples:"
    echo "  ./setup-all.sh --migrate                         # Migrate current project"
    echo "  ./setup-all.sh --migrate /c/Users/name/project2  # Migrate specific project"
    echo "  ./setup-all.sh --migrate \"C:\\Users\\name\\proj2\"    # Windows path"
    echo ""
    echo "Supported Databases (shared by type):"
    echo "  - PostgreSQL:  projexlight-postgres  (port 5432)"
    echo "  - MySQL:       projexlight-mysql     (port 3306)"
    echo "  - MariaDB:     projexlight-mariadb   (port 3306)"
    echo "  - MongoDB:     projexlight-mongodb   (port 27017)"
    echo "  - Redis:       projexlight-redis     (port 6379)"
    echo "  - Cassandra:   projexlight-cassandra (port 9042)"
    echo "  - DynamoDB:    projexlight-dynamodb  (port 8000)"
    echo "  - SQLite:      (no container needed)"
    echo ""
}

# Run init-scripts on existing database
run_init_scripts_cmd() {
    check_prerequisites

    local db_type=$(get_db_type)
    local container=$(get_db_container_name "$db_type")

    if ! container_running "$container"; then
        error "Database container ($container) is not running"
        exit 1
    fi

    # Read database config
    local db_name="appdb"
    local db_user="appuser"
    local db_pass="apppassword"

    if [ -f "$CONFIG_FILE" ]; then
        if command -v jq &> /dev/null; then
            db_name=$(jq -r '.databaseConfig.database // "appdb"' "$CONFIG_FILE" 2>/dev/null)
            db_user=$(jq -r '.databaseConfig.username // "appuser"' "$CONFIG_FILE" 2>/dev/null)
            db_pass=$(jq -r '.databaseConfig.password // "apppassword"' "$CONFIG_FILE" 2>/dev/null)
        fi
    fi

    run_init_scripts "$db_type" "$container" "$db_name" "$db_user" "$db_pass"
}

# Run database migration for a specific project
# Args: $1 = project path (optional, defaults to current project)
run_migrate_cmd() {
    local target_path="${1:-$PROJECT_ROOT}"
    check_prerequisites

    log "Running database migration..."

    if [ "$target_path" = "$PROJECT_ROOT" ]; then
        # Migrate current project
        run_init_scripts_cmd
    else
        # Migrate additional project
        run_additional_project_init_scripts "$target_path"
    fi
}

# Parse command line
case "${1:-}" in
    --status)
        show_status
        ;;
    --register)
        check_prerequisites
        register_project
        ;;
    --sync-creds|--sync-credentials)
        check_prerequisites
        log "Checking and syncing credentials from mcp-config.json..."
        if check_credential_sync; then
            info "Credentials already in sync - no action needed"
        else
            warn "Credential mismatch detected - syncing..."
            sync_credentials
        fi
        # Complete owner metadata (projectPath/expiresAt/projectName) even when the
        # apiKey matches — fixes the bare fresh self-registration that breaks set_context.
        complete_project_metadata
        prune_deleted_projects
        log "Done! Try your MCP tool call again."
        ;;
    --install-hooks)
        install_hooks
        ;;
    --init-scripts)
        run_init_scripts_cmd
        ;;
    --migrate)
        # Check if a path argument was provided
        if [ -n "${2:-}" ]; then
            run_migrate_cmd "$2"
        else
            run_migrate_cmd
        fi
        ;;
    --force)
        check_prerequisites
        force_restart
        ;;
    --help|-h)
        show_usage
        ;;
    "")
        run_setup
        ;;
    *)
        error "Unknown option: $1"
        show_usage
        exit 1
        ;;
esac
