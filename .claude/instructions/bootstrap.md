# ProjexLight Code Generation

## STEP 0: VERIFY CURL IS INSTALLED (MANDATORY)

Before proceeding, you MUST verify curl is available. Run this check:

```bash
curl --version
```

### If curl is NOT installed:

**Windows (run in PowerShell as Admin):**
```powershell
winget install curl.curl
```
Or download from: https://curl.se/windows/

**macOS:**
```bash
brew install curl
```

**Linux (Ubuntu/Debian):**
```bash
sudo apt-get update && sudo apt-get install -y curl
```

**Linux (CentOS/RHEL/Fedora):**
```bash
sudo yum install -y curl
```

**Alpine Linux:**
```bash
apk add curl
```

### ⚠️ STOP IF CURL INSTALLATION FAILS

If curl cannot be installed automatically:
1. **STOP code generation immediately**
2. **Tell the user:** "curl is required but not installed. Please install curl manually and restart."
3. **DO NOT proceed** until curl is confirmed working

### Verify curl works:
```bash
curl --version
```
If this shows version info, proceed to Step 1.

---

## STEP 1: DETECT PROJECT PATH

First, get your project path in Unix format:

**Windows:** Convert `C:\Users\name\project` to `/c/Users/name/project`
**Mac/Linux:** Use path as-is (e.g., `/Users/name/project`)

---

## STEP 1.5: VERIFY CODEBASE (LEGACY EXTRACTION ONLY)

Read `.projexlight/context/framework-config.json`. If it contains a `repository_url` field, this is a legacy extraction project that needs the source codebase.

**Check if source code exists in project root:**
- Look for source files: package.json, requirements.txt, pom.xml, go.mod, Cargo.toml, etc.
- Look for source directories: src/, lib/, app/, server/, client/

**If source code is NOT present and `repository_url` exists:**
```bash
git clone <repository_url> temp_clone && cp -r temp_clone/* . && cp -r temp_clone/.* . 2>/dev/null; rm -rf temp_clone
```
If cloning fails (private repo), ask the user to clone manually into this directory.

**If source code already exists:** Skip cloning and proceed.

---

## STEP 2: READ PROJECT CONFIGURATION

```
.projexlight/context/framework-config.json
```

This tells you the language/framework. If all values are null, this is likely a legacy extraction project.

---

## STEP 3: GET COMPLETE WORKFLOW

**IMPORTANT:** Pass your projectPath to get the correct workflow (auto-detects legacy vs new development):

```bash
curl "http://localhost:8766/api/instruction/bootstrap?projectPath=<YOUR_PROJECT_PATH>"
```

Example:
```bash
curl "http://localhost:8766/api/instruction/bootstrap?projectPath=/c/Users/name/myproject"
```

This returns the complete EXECUTION_FLOW with all phases and MCP tools.
- **Legacy Extraction projects:** Returns legacy API extraction workflow with extraction tools
- **New Development projects:** Returns standard development workflow

---

## STEP 3.5: SET UP MCP AND USE `projexlight_*` TOOLS (MANDATORY)

**After the initial bootstrap curl call in Step 3, every subsequent API interaction MUST go through `projexlight_*` MCP tools. curl is NOT an acceptable fallback for the ProjexLight workflow.**

### Step 3.5.a — Check whether MCP tools are already loaded

Your CLI host (Claude Code / Cursor / Windsurf / Copilot / Goose / Cline / Amazon Q / Antigravity) exposes connected MCP tools in your tool list. Look for any tool whose name starts with `projexlight_`.

- **If one or more `projexlight_*` tools are visible** → MCP is connected. Skip to Step 3.5.c and use them.
- **If zero `projexlight_*` tools are visible** → MCP is not yet set up. Go to Step 3.5.b.

### Step 3.5.b — Set up MCP from PROJEXLIGHT_SETUP.md

**Read `PROJEXLIGHT_SETUP.md` at the project root and follow it end-to-end.** That file is the authoritative setup guide shipped with every export — it covers Docker Compose prerequisites, the `mcp-server/setup-all.sh` bootstrap script, health checks on `http://localhost:8766/health`, and CLI-host registration.

```bash
# Follow PROJEXLIGHT_SETUP.md — the canonical steps are:
cd mcp-server && ./setup-all.sh          # creates containers, registers project
curl http://localhost:8766/health         # confirm server is up
```

After `setup-all.sh` completes AND the CLI host has been restarted / reloaded so the MCP server is registered, re-check your tool list. If `projexlight_*` tools still do not appear, **STOP and ask the user to complete MCP registration** — do NOT proceed with curl.

### Step 3.5.c — Use the MCP tools for the workflow

Call tools by name directly (your CLI host handles the transport). Tool arguments like `sessionToken`, `projectId`, and `projectPath` are injected by the bridge — you do not pass them.

### Supported `projexlight_*` tools (51 total)

**Session & core workflow (6):**
`projexlight_init_session`, `projexlight_get_instruction`, `projexlight_validate`, `projexlight_complete_task`, `projexlight_get_rules`, `projexlight_decision_tree`

**Quality & validation (5):**
`projexlight_quality_gates`, `projexlight_get_template`, `projexlight_self_check`, `projexlight_submit_feature_validation`, `projexlight_validate_api_definition`

**Violations & test failures (6):**
`projexlight_get_pending_violations`, `projexlight_clear_violations`, `projexlight_get_pending_test_failures`, `projexlight_clear_test_failures`, `projexlight_mark_test_manual`, `projexlight_reset_failure_counts`

**Session context (2):**
`projexlight_set_context`, `projexlight_get_context`

**Imports (6):**
`projexlight_import_validate`, `projexlight_import_full`, `projexlight_import_epics`, `projexlight_import_features`, `projexlight_import_scenarios`, `projexlight_import_status`

**API testing (6):**
`projexlight_run_api_tests`, `projexlight_start_api_tests`, `projexlight_get_api_test_status`, `projexlight_cancel_api_tests`, `projexlight_clear_api_test_result`, `projexlight_check_server_health`

**Legacy extraction (5):**
`projexlight_legacy_detect_framework`, `projexlight_legacy_scan_routes`, `projexlight_legacy_extract_apis`, `projexlight_legacy_generate_definitions`, `projexlight_legacy_bootstrap`

**Epic / feature / scenario / task CRUD (15):**
`projexlight_create_task`, `projexlight_get_tasks_by_feature`, `projexlight_implement`, `projexlight_get_epic`, `projexlight_get_feature`, `projexlight_get_scenario`, `projexlight_update_scenario_steps`, `projexlight_create_scenario`, `projexlight_get_task`, `projexlight_list_epics`, `projexlight_get_features_by_epic`, `projexlight_get_scenarios_by_feature`, `projexlight_get_tasks_by_feature_lookup`, `projexlight_get_tasks_by_scenario`, `projexlight_create_tasks_bulk`

### Common curl → MCP tool replacements
| Instead of curl to... | Use MCP tool |
|---|---|
| `POST /api/instruction/init` | `projexlight_init_session` |
| `POST /api/instruction/get` | `projexlight_get_instruction` |
| `POST /api/instruction/validate` | `projexlight_validate` |
| `POST /api/instruction/complete` | `projexlight_complete_task` |
| `GET /api/instruction/rules` | `projexlight_get_rules` |
| `POST /api/test/start` | `projexlight_start_api_tests` |
| `GET /api/test/status` | `projexlight_get_api_test_status` |

### Why MCP tools are mandatory (not a preference)
- MCP tools inject `sessionToken`, `projectId`, and `projectPath` automatically — curl calls routinely drop or mistype these, which silently breaks the workflow
- Responses are structured JSON that your CLI can reason about; curl output is unparsed text
- The curl surface is not stable across releases; the MCP tool surface is

**The ONLY curl call in the entire session is Step 3's `/api/instruction/bootstrap`. Every call after that MUST be an MCP tool. If you catch yourself about to run curl, STOP and either use the mapped tool above or run Step 3.5.b to finish MCP setup.**

---

## STEP 4: FOLLOW EXECUTION_FLOW FROM RESPONSE

Execute each phase automatically. DO NOT ask for confirmation. Use MCP tools (not curl) for each step when available.

The response includes:
- **PROJECT_TYPE**: "legacy_extraction" or "new_development"
- **MCP_TOOLS**: Available tools for this project type
- **EXECUTION_FLOW**: Step-by-step workflow to follow
- **NEXT_STEP**: First action to take

---

## CRITICAL RULES

- Pass projectPath in bootstrap call to detect correct workflow
- Read framework-config.json to know language/framework
- **Use `projexlight_*` MCP tools for all API calls after the initial bootstrap curl** — if the tools are not loaded in your CLI, follow `PROJEXLIGHT_SETUP.md` at the project root to set up MCP; never substitute curl for the workflow tools
- Execute all steps automatically - DO NOT ask for confirmation
- Follow NEXT_STEP in each API response
- Validate before commit - only commit when validation.passed === true
- If any curl command fails, check MCP server: `docker ps | grep projexlight`

---

Project: cf30e9b7... | Tasks: 53

## Notes

Instructions delivered via MCP server.
