# ProjexLight Dev MCP Guide

The **Dev MCP** is the code-generation and code-review side of ProjexLight's MCP server pair. It runs in Docker on your local machine, integrates with your git workflow via automated hooks, and works with your AI coding assistant (Claude Code, Cursor, Cline, etc.).

This guide consolidates everything you need to run, configure, and troubleshoot the Dev MCP. For running tests (UI / API from feature files or the ProjexLight database), see [`TEST_MCP.md`](./TEST_MCP.md). For framework-specific SUT setup, see [`SUT_SETUP_GUIDE.md`](./SUT_SETUP_GUIDE.md).

## Table of contents

- [What the Dev MCP does](#what-the-dev-mcp-does)
- [Prerequisites](#prerequisites)
- [Starting the Dev MCP container](#starting-the-dev-mcp-container)
- [Authentication](#authentication)
- [Git hooks — automatic installation](#git-hooks--automatic-installation)
- [Pre-commit hook — duplicate API detection](#pre-commit-hook--duplicate-api-detection)
- [Pre-push hook — API test execution](#pre-push-hook--api-test-execution)
- [API test workflow and LLM-generated test data](#api-test-workflow-and-llm-generated-test-data)
- [SUT connectivity requirements](#sut-connectivity-requirements)
- [Multi-project support](#multi-project-support)
- [Logs and observability](#logs-and-observability)
- [Debugging scenarios](#debugging-scenarios)
- [Custom headers and variable resolution](#custom-headers-and-variable-resolution)
- [Cheat sheet](#cheat-sheet)

---

## What the Dev MCP does

The Dev MCP provides **four** capabilities during code generation:

1. **Instruction delivery** — fetches task-by-task instructions from ProjexLight so your AI assistant knows what to build next and which coding standards to follow
2. **Code review** — analyzes generated code for governance violations, coding standard drift, and architectural layer breaks
3. **Pre-commit duplicate detection** — scans staged files for APIs that already exist in the `api_library`, blocks commits that would create duplicates
4. **Pre-push API testing** — generates realistic test data via LLM, runs the APIs changed in the push, and reports results back to the ProjexLight dashboard

Everything is triggered from your normal development workflow — `git add && git commit && git push`. You do not manually invoke the Dev MCP beyond starting its container.

---

## Prerequisites

- Docker Desktop (Windows/Mac) or Docker Engine (Linux) — version 20.10+
- Git — installed on your host (not in the container)
- Your AI coding tool with MCP support (Claude Code, Cursor, Cline, Goose, Windsurf, Aider)
- A **running SUT** (your web app under test) bound to `0.0.0.0` — see [SUT_SETUP_GUIDE.md](./SUT_SETUP_GUIDE.md) for framework-specific commands. Pre-push API tests **will fail** if your SUT is bound to `127.0.0.1` only.

---

## Starting the Dev MCP container

From your project's `mcp-server/` directory:

```bash
cd mcp-server
./setup-all.sh              # Start all services (database + Dev MCP + Test MCP)
# Or start Dev MCP only:
./setup-dev-mcp.sh start
```

Wait about 30 seconds for initialization, then verify:

```bash
curl http://localhost:8766/health
```

**Expected response:**
```json
{
  "status": "healthy",
  "uptime": "...",
  "workspace": "/workspace"
}
```

**Container binding note:** starting from the compose file included in this CLI export, port 8766 is bound to **loopback only** (`127.0.0.1:8766` and `[::1]:8766`) for security — the MCP HTTP API has no per-request authentication and should not be exposed to your LAN. To override:

```bash
# .env
MCP_DEV_BIND=0.0.0.0
MCP_DEV_BIND6=::
```

Only do this if you have a specific need (e.g., testing from another machine on your local network). For most developers, loopback is what you want.

---

## Authentication

The Dev MCP supports two authentication methods for talking to the ProjexLight platform:

### Method 1 — `mcp-config.json` (recommended for developers)

When you CLI-export a project from ProjexLight, `mcp-server/mcp-config.json` is generated with your encrypted API key and LLM credentials. The Dev MCP auto-decrypts it on startup using your project ID as the key-derivation input.

### Method 2 — Environment variables (for QA and CI/CD)

Set these in `mcp-server/.env` instead of using `mcp-config.json`:

```bash
PROJEXLIGHT_API_KEY=ak_...          # Your tenant API key from ProjexLight → Settings → API Keys
PROJEXLIGHT_PROJECT_ID=...          # Your project UUID
OPENAI_API_KEY=sk-...               # For LLM-based test data generation
LLM_PROVIDER=openai                 # Or anthropic, azure, etc.
LLM_MODEL_REVIEW=gpt-4o-mini        # Model used for code review
```

**Priority**: `mcp-config.json` is used first if present; environment variables are the fallback.

### Check which method is active

```bash
docker logs projexlight-dev-mcp 2>&1 | grep "Config Source"
```

---

## Git hooks — automatic installation

The Dev MCP installs git hooks automatically on **first startup** when it detects a `.git` directory in the mounted workspace. You do not need to run any manual installer.

### What gets installed

| Hook | Trigger | Purpose | Blocking? |
|---|---|---|---|
| `pre-commit` | `git commit` | Scan staged files for duplicate APIs against `api_library`; block commit if duplicates found | **Yes** |
| `pre-push` | `git push` | Run API tests on changed files, generate LLM test data, report results | **Optional** (configurable) |

Both hooks are copied from the Dev MCP image's `templates/` directory into `<project>/.git/hooks/` and made executable. On Windows, exec bit is set via Git Bash conventions.

### Verifying hooks are installed

```bash
curl http://localhost:8766/hooks/status
```

Response:
```json
{
  "pre-commit": { "installed": true, "executable": true, "upToDate": true },
  "pre-push":   { "installed": true, "executable": true, "upToDate": true }
}
```

If a hook shows `upToDate: false`, restart the Dev MCP container to pick up the latest template:

```bash
./setup-dev-mcp.sh restart
```

### Manually reinstalling hooks

If you need to reinstall (e.g., after `git init` on a new branch):

```bash
curl -X POST http://localhost:8766/hooks/install
```

### Graceful degradation when the MCP is offline

If the Dev MCP container is stopped when you commit or push, the hooks **do not block** — they print a warning and let the operation proceed. This ensures your git workflow never gets stuck behind a down MCP.

### Bypassing hooks (emergency only)

```bash
git commit --no-verify -m "Emergency fix — skipping MCP checks"
git push --no-verify
```

Use sparingly. The bypass is visible in git history and reviewers may challenge it.

---

## Pre-commit hook — duplicate API detection

On every `git commit`, the hook:

1. **Reads staged files** via `git diff --cached --name-only`
2. **Extracts API endpoints** from changed route files (Express, FastAPI, Spring, etc.)
3. **Queries `api_library`** on ProjexLight to check if any of those `method + path` combinations already exist
4. **Blocks the commit** if duplicates are found, printing resolution options

### Example output — no duplicates

```
🔍 Pre-commit: Scanning 3 staged files for duplicate APIs...
   ✓ src/routes/leads.js (2 new endpoints)
   ✓ src/routes/auth.js (1 new endpoint)
   ✓ src/models/Lead.js (no APIs detected)

✅ No duplicates found — commit proceeding.
```

### Example output — duplicate detected

```
🔍 Pre-commit: Scanning 2 staged files for duplicate APIs...
❌ DUPLICATE API DETECTED:

  Method: POST
  Path:   /api/leads
  File:   src/routes/leads-v2.js:47
  Existing: api_library entry #a1b2c3 — POST /api/leads (src/routes/leads.js:23)

  Options:
    1. Delete the duplicate in src/routes/leads-v2.js
    2. Rename the path in src/routes/leads-v2.js (e.g., /api/leads/v2)
    3. Extend the existing endpoint instead of creating a new one

  Run this to unstage the duplicate file:
    git reset HEAD src/routes/leads-v2.js

git commit aborted.
```

The hook is fast — **2–3 seconds per commit** — because it only scans staged files, not the entire project.

---

## Pre-push hook — API test execution

On every `git push`, the hook:

1. **Checks** that the MCP server is reachable (graceful degrade if not)
2. **Verifies your SUT is running and bound correctly** via the built-in `check-sut.sh` helper — blocks the push with a pointer to [SUT_SETUP_GUIDE.md](./SUT_SETUP_GUIDE.md) if your SUT is bound to `127.0.0.1` instead of `0.0.0.0`
3. **Identifies changed route files** between `origin/<branch>` and `HEAD`
4. **Starts an async API test run** by POSTing to `http://localhost:8766/api/test/start` with the changed-file list
5. **Polls for results** every 3 seconds (configurable via `API_TEST_POLL_INTERVAL`) until completion or timeout (`API_TEST_MAX_WAIT=3600` seconds default)
6. **Reports** pass/fail counts, duration, and a link to the test run in the ProjexLight dashboard
7. **Blocks** or **warns** based on `API_TEST_MODE`

### Modes

```bash
# Incremental — test only APIs touched by this push (default)
API_TEST_MODE=incremental git push

# Full — test every API in the project (slower but thorough)
API_TEST_MODE=full git push
```

### Example output — all tests pass

```
🧪 Running API tests (mode: incremental)...
   Source: tests/api_definitions/ (LLM-generated)
   Incremental mode: Testing APIs matching changed files

   Starting API tests...
   ✓ Tests started (ID: tr-abc123)

   Polling for completion...
   ✓ Test run complete (24s)

  Total APIs tested: 11
  Passed: 11
  Failed: 0
  Duration: 24.3s

✅ All API tests passed — push proceeding.
```

### Example output — SUT not reachable

```
🔍 Pre-push: Checking MCP server...
   ✓ MCP server reachable at http://localhost:8766

🔍 Checking local dev server...
   ✓ Server is running on port 3005
   Running SUT bind-address pre-flight...

   → Checking http://localhost:3005
     ✗ Port 3005 is bound to 127.0.0.1 (loopback only)

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
❌ PUSH BLOCKED: SUT is not reachable from Dev MCP
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Your dev server is running, but it is not reachable from
inside the Dev MCP container. The most common cause is the
server binding to 127.0.0.1 instead of 0.0.0.0.

See the full framework-specific fix guide:
   /workspace/mcp-server/docs/SUT_SETUP_GUIDE.md

To bypass this check for one push (NOT recommended):
   SKIP_SUT_CHECK=true git push
```

### Example output — API test failures

```
🧪 Running API tests (mode: incremental)...
   Tests started (ID: tr-def456)
   ...
   Test run complete (18s)

  Total APIs tested: 11
  Passed: 9
  Failed: 2

❌ 2 API test(s) failed out of 11 total:

  1. POST /api/leads — 500 Internal Server Error
     Expected: 201 Created
     Error:    duplicate key value violates unique constraint
     File:     src/routes/leads.js:47

  2. GET /api/leads/:id — 404 Not Found
     Expected: 200 OK
     Error:    No lead with id 'test-lead-1'
     File:     src/routes/leads.js:89

  Fix these failures before pushing. Run the tests manually:
    curl -X POST http://localhost:8766/api/test \
      -H 'Content-Type: application/json' \
      -d '{"projectPath": "/workspace", "api_test_mode": "full"}'

  Or bypass (NOT recommended):
    git push --no-verify
```

---

## API test workflow and LLM-generated test data

The pre-push hook generates realistic test data on the fly using an LLM. Here's what happens behind the scenes for a typical 2-commit push containing **15 files** and **11 new APIs**:

### Stage 1 — File filtering

From 15 changed files, the hook filters to **4 route files** (files that actually contain HTTP route definitions). Non-route changes like `src/models/*.js` and `src/components/*.tsx` are skipped — they don't expose APIs to test.

### Stage 2 — API extraction

For each route file, the hook parses the code to extract:

- Method (`GET`, `POST`, `PATCH`, `PUT`, `DELETE`)
- Path (`/api/leads/:id`)
- Auth requirement (does the route use `authenticate` middleware?)
- Expected request body schema (from Joi/Zod/class-validator definitions)
- Expected response schema (from return types or OpenAPI decorators)
- Dependencies (does this route reference other APIs? e.g., `/api/orders/:id` requires a valid order)

Result: **11 API definitions** extracted from 4 files.

### Stage 3 — LLM test data generation

For each API, the Dev MCP sends the extracted schema to the configured LLM (e.g., `gpt-4o-mini`) with a prompt like:

```
Generate realistic test data for this API:
POST /api/leads
Body schema:
  name: string (required, 3-50 chars)
  email: string (required, email format)
  company: string (optional, max 100 chars)
  status: enum('new', 'contacted', 'qualified', 'disqualified')

Return JSON with 3 variations: one positive case, one edge case
(boundary values), one negative case (invalid data).
```

The LLM returns structured JSON like:
```json
{
  "positive": { "name": "Jane Doe", "email": "jane@acme.com", "company": "Acme Corp", "status": "new" },
  "edge":     { "name": "A"*50, "email": "a+tag@example.com", "status": "contacted" },
  "negative": { "name": "", "email": "not-an-email", "status": "invalid_status" }
}
```

### Stage 4 — Authentication auto-login

If any API requires auth, the hook auto-detects the login endpoint and runs a full login flow:

```
→ POST /api/auth/register  { email: "test-user@example.com", password: "TestPass123!" }
→ POST /api/auth/login     { email: "test-user@example.com", password: "TestPass123!" }
→ Captured: accessToken = "eyJhbGci..."
```

All subsequent API calls attach the token as `Authorization: Bearer <token>`.

### Stage 5 — Dependency chain setup

If APIs have dependencies (e.g., `GET /api/orders/:id` needs a valid order ID), the hook resolves the chain in order:

```
→ POST /api/users      → created user u-123
→ POST /api/products   → created product p-456
→ POST /api/orders     { userId: u-123, productId: p-456 }  → created order o-789
→ GET  /api/orders/o-789   ← now runs with a valid dependency
```

### Stage 6 — Test execution and cleanup

All 11 APIs run against your local SUT via `host.docker.internal:<port>`. Results are captured per-API:

- HTTP status code
- Response body
- Response time
- Error details (if failed)

After the test run, cleanup deletes the test data:

```
← DELETE /api/orders/o-789
← DELETE /api/products/p-456
← DELETE /api/users/u-123
```

### Timings

For a typical 2-commit / 15-file / 11-API push:

| Phase | Duration |
|---|---|
| Pre-commit #1 | ~2s |
| Pre-commit #2 | ~3s |
| Pre-push total | ~10s |
| **Total overhead per push** | **~15s** |

---

## SUT connectivity requirements

The single most common failure mode for Dev MCP pre-push tests is **`Cannot connect to host host.docker.internal:PORT`**. This happens when your web application is running but bound to `127.0.0.1` (loopback only) instead of `0.0.0.0` (all interfaces).

**Full framework guide**: [SUT_SETUP_GUIDE.md](./SUT_SETUP_GUIDE.md) — covers Express, NestJS, Django, Flask, FastAPI, Spring Boot, Go, Rails, Vite, Create React App, Next.js, Angular, Nuxt, SvelteKit, Astro. Each entry has the wrong command, the right command, and verification steps.

**Quick reference**:

| Framework | Right command |
|---|---|
| Express | `app.listen(3005)` (Node default is `0.0.0.0`) |
| Vite | `npm run dev -- --host` |
| Next.js | `next dev -H 0.0.0.0` |
| CRA | `HOST=0.0.0.0 npm start` |
| Angular | `ng serve --host 0.0.0.0 --disable-host-check` |
| Django | `python manage.py runserver 0.0.0.0:8000` |
| Flask | `flask run --host=0.0.0.0` |
| FastAPI | `uvicorn main:app --host 0.0.0.0` |

The pre-push hook runs `check-sut.sh` automatically. If you see a `PUSH BLOCKED` message about SUT bind, fix the server and retry — don't use `SKIP_SUT_CHECK=true` except in emergencies.

---

## Multi-project support

One Dev MCP container can serve multiple projects mounted as additional workspaces. This is useful when you work on 2–4 related repos simultaneously and don't want a separate MCP per project.

### First project (owner)

When you run `./mcp-server/setup-all.sh` for the first time, it starts the Dev MCP container with `../` mounted at `/workspace`. This is the **owner project**.

### Additional projects

Register another project without restarting containers:

**Option A — Via web UI**:
```
http://localhost:8766/projects
```
Click **Register New Project**, enter the project path.

**Option B — Via API**:
```bash
curl -X POST http://localhost:8766/api/projects/register \
  -H 'Content-Type: application/json' \
  -d '{
    "projectId": "<uuid>",
    "projectName": "My Second Project",
    "projectPath": "/c/Users/me/project-2",
    "workspacePath": "/c/Users/me/project-2"
  }'
```

**Option C — Via setup script**:
```bash
./mcp-server/setup-all.sh --register-additional /path/to/project-2
```

### Checking registered projects

```bash
curl http://localhost:8766/api/projects 2>/dev/null | jq
```

Returns:
```json
{
  "projects": [
    { "projectId": "...", "projectName": "Owner Project", "isOwner": true, "containerPath": "/workspace" },
    { "projectId": "...", "projectName": "My Second Project", "isOwner": false, "containerPath": "/projects/additional1" }
  ]
}
```

Owner projects **cannot be removed** — they own the container lifecycle. Additional projects can be removed via:
```bash
curl -X DELETE http://localhost:8766/api/projects/<projectId>
```

### Container path slots

Additional projects are mounted at `/projects/additional1`, `/projects/additional2`, `/projects/additional3`. Up to 3 extra projects per container is supported out of the box.

---

## Logs and observability

### Log locations

| Log | Path inside container | Content |
|---|---|---|
| `server` | `/feedback/logs/mcp-server-YYYYMMDD-HHMMSS.log` | Main request/response log |
| `activity` | `/feedback/logs/file-activity-*.log` | File change detection |
| `reviews` | `/feedback/logs/code-reviews-*.log` | Code review results |
| `errors` | `/feedback/logs/errors-*.log` | Error-level messages only |

All logs are mirrored to `./mcp-server/feedback/logs/` on your host (via the `./feedback:/feedback` volume mount).

### Viewing logs via HTTP

```bash
curl http://localhost:8766/logs/server?lines=100
curl http://localhost:8766/logs/errors?lines=200
curl http://localhost:8766/logs/reviews?lines=50
curl http://localhost:8766/logs/activity?lines=50
curl http://localhost:8766/logs/all?lines=100
```

### Viewing logs via Docker

```bash
docker logs projexlight-dev-mcp -f     # Follow live
docker logs projexlight-dev-mcp | tail -100   # Last 100 lines
```

### Log rotation

Each log type rotates at **10 MB** with **5 backup files** retained. Older logs are removed automatically. If you need longer retention, mount `./feedback/logs` to a persistent volume and archive externally.

---

## Debugging scenarios

### 1. Git hooks are not running on commit or push

```bash
# Verify hooks are installed
curl http://localhost:8766/hooks/status

# If not installed, re-run the installer
curl -X POST http://localhost:8766/hooks/install

# Verify executable bit
ls -la .git/hooks/pre-commit .git/hooks/pre-push

# On Windows, test the hook manually
bash .git/hooks/pre-push origin refs/heads/main
```

### 2. Config decryption failed at startup

```
❌ Failed to decrypt config: Invalid authentication tag
```

Usually means `mcp-config.json` was generated for a different project ID than the one in the decryption key path. Re-export from ProjexLight.

```bash
# Check which config source loaded
docker logs projexlight-dev-mcp 2>&1 | grep -i "config source"

# Manually inspect the file
head -5 mcp-server/mcp-config.json   # Should show projectId + encryptedPlatformApiKey
```

### 3. Component duplication scan is not detecting duplicates

```bash
# Verify api_library is populated
curl http://localhost:8766/api/api-library/count

# Force a fresh scan of the current file
curl -X POST http://localhost:8766/api/api-library/scan \
  -H 'Content-Type: application/json' \
  -d '{"filePath": "src/routes/leads.js"}'
```

### 4. MCP server not starting (container exits immediately)

```bash
# Check container status
docker ps -a | grep projexlight-dev-mcp

# Get exit reason
docker logs projexlight-dev-mcp

# Common causes:
#   - mcp-config.json missing or invalid JSON
#   - MCP_ENCRYPTION_KEY env var empty
#   - Port 8766 already in use (check with: netstat -ano | grep :8766)
```

### 5. "Server not running" reported by pre-push even though it is

```bash
# The pre-push hook detects your SUT via http://localhost:$SERVER_PORT
# Make sure SERVER_PORT is set in mcp-server/.env or detectable from your .env

# Manually verify:
curl -I http://localhost:3005/   # Your SUT port
curl -I http://localhost:8766/health   # Dev MCP port

# If curl succeeds but the hook says "not running", check that your
# SUT is bound to 0.0.0.0 (not 127.0.0.1) — the hook probes via
# host.docker.internal from inside the container.
```

### 6. Pre-push hook hangs forever

```bash
# Tests may be running in the background — check:
curl http://localhost:8766/api/test/status

# Or force-stop:
curl -X POST http://localhost:8766/api/test/stop

# Increase timeout for long test runs:
API_TEST_MAX_WAIT=7200 git push    # 2 hours
```

---

## Custom headers and variable resolution

Three programs build a request from the same api definition — the **Dev MCP**
(from `tests/api_definitions/` on disk), the **Test MCP** (from `api_library`),
and the **ProjexLight backend** (the UI's quick / chain / workflow / dataset /
manual modes). They must agree, so header assembly is specified here rather than
invented per executor. A header configured in one place but honoured in another
is the worst outcome available: a green local run reads as proof.

### Header layers, in order

A later layer overwrites an earlier one for the same header name.

| # | layer | where it lives | use it for |
|---|---|---|---|
| 1 | `defaultHeaders` | test-config, global | `Accept`, `x-api-version` |
| 2 | `environments[env].headers` | test-config, per env | env-specific keys |
| 3 | `providers[].headers` | test-config, matched on path/host | third-party integration |
| 4 | `testCredentials.<role>.headers` | test-config, when the definition sets `requiresRole` | `x-admin-ops-token` |
| 5 | `headers` | the api definition | endpoint-specific |
| 6 | `testCases[].headers` | the executing dataset | a negative case overriding the happy path |
| 7 | `computedHeaders` | test-config | request signatures — runs last, over the final body |

A `null`/`""` value in a later layer **removes** the header instead of setting an
empty one. `providers[]` may also carry an `auth` block, which replaces the
environment's scheme for requests it matches.

### Worked example — a role-scoped header

An endpoint behind an admin capability. Do **not** hand-write the token into the
definition; declare the role and let the runner fetch it:

```jsonc
// tests/config/test-config.json
"testCredentials": {
  "admin": { "email": "qa.admin@example.test", "password": "…" }
}
```

```jsonc
// tests/api_definitions/<area>/<endpoint>.json
{ "requiresRole": ["admin"] }        // and NO Authorization header — see below
```

The runner logs in once per declared role and injects that identity.

### The mistake this prevents

**A definition-supplied `Authorization` beats the role token.** If you declare
`requiresRole` *and* set `Authorization` on the dataset, the header wins, the
role token is never sent, and the endpoint answers **403** — which reads as a
permissions bug in the API. It is not; it is the definition overriding its own
role. Declare one or the other, never both.

### Testing the unauthenticated path

A dataset must be able to send **no** `Authorization`. Use `"noAuth": true`, or
`"Authorization": null`. A dataset expecting `401` that supplies no
`Authorization` of its own is treated as `noAuth` automatically — handing it a
valid token would make its assertion impossible to satisfy.

`403` is **not** inferred. A 403 case is normally authenticated-but-not-permitted,
so it needs a credential; sending none gets `401` and the test fails for the
wrong reason. A 403 case that really is anonymous says so with `"noAuth": true`.

A dataset that expects `401` but declares its own `Authorization` is testing a
**bad** token, not the absence of one — its header is left exactly as written.

All four executors are held to this by `parity/header-parity-fixture.json`,
which every executor runs against its own resolver
(`dist/parity/check_parity.py` for both MCPs, `npm run parity:headers` for the
ProjexLight backend). The harness offers a token before applying the rule — a
harness that never offers one turns every "sends no Authorization" case into a
pass that proves nothing.

### Removing a header a broader layer set

A `null` or `""` value is a **removal**, not an empty value to send:

```jsonc
// testCases[]
{ "name": "400 - rejects a request with no api key",
  "expectedStatus": 400,
  "headers": { "x-api-key": null } }
```

It is the only way a narrow layer can un-set what a broad one configured — "reject
when `x-api-key` is absent" is untestable if layer 1 always re-adds it. Removal is
per header: everything else the project configures still goes out, so a negative
case does not lose `Content-Type` and 415 for the wrong reason.

### A second system with its own credential

A customer's legacy API or a third-party integration authenticates differently
from the application under test. Give it `providers[].auth`:

```jsonc
"providers": [
  { "match": "/api/legacy",
    "headers": { "x-legacy-client": "projexcloud" },
    "auth": { "type": "api_key", "header": "X-Legacy-Key", "value": "{{var:legacy_key}}" } },
  { "match": "/api/partner", "auth": { "type": "none" } }
]
```

A matching provider's auth **replaces** the environment's scheme for that request
rather than layering on top of it. The environment credential belongs to the app
under test; sending it to a third party hands out the tenant's token on every
call. `"type": "none"` states that this host gets nothing — which is not the same
as omitting the block, and omitting it means "use the environment's credential
here".

### Signed webhooks

```jsonc
"computedHeaders": {
  "x-hub-signature-256": {
    "algorithm": "hmac-sha256",
    "secret": "{{var:meta_webhook_secret}}",
    "over": "raw_body",
    "prefix": "sha256=",
    "encoding": "hex"
  }
}
```

Computed **after** the body is final, over the exact bytes sent. Anything that
edits the body afterwards invalidates the signature.

### Enterprise signatures — signing the request, not the payload

`over: "raw_body"` covers GitHub- and Meta-style webhooks. Most enterprise schemes
(SigV4, Azure SharedKey, WSSE) sign a **canonical string** built from the method,
path, a timestamp and a hash of the body, and require companion headers that the
signature itself covers:

```jsonc
"computedHeaders": {
  "x-legacy-signature": {
    "algorithm": "hmac-sha256",
    "secret": "{{var:legacy_secret}}",
    "over": "canonical",
    "template": "{method}\n{path}\n{timestamp}\n{bodyHash}",
    "emit": { "x-legacy-timestamp": "{timestamp}" },
    "timestampFormat": "epoch_s",
    "bodyHashAlgorithm": "sha256",
    "encoding": "hex",
    "match": "/api/legacy"
  }
}
```

Tokens: `{method} {path} {query} {body} {bodyHash} {timestamp} {nonce}
{header:Name}`, plus `{{var:...}}`. `emit` headers are set **before** signing, so
`{header:x-legacy-timestamp}` reads back the value that was actually sent. An
unknown token is left verbatim — `{acount}` is a visible typo, whereas a silently
empty field is a 401 with no explanation on the wire.

### Where values come from

`{{var:name}}` resolves most-specific-first: dataset → api →
`environments[<activeEnvironment>].variables` → global `variables`.

**Secrets belong to an environment, never to global.** A global applies to every
environment, so a dev secret placed there reaches staging and production.

`{{cache:producer.path}}` is the only correct form for a foreign key — it comes
from a producer that actually created the record. An unresolved placeholder is
reported as blocked and never replaced with a generated value: substituting a
random UUID turns a wiring error into a confusing 404 several endpoints away.

### Negative datasets are never repaired

An executor must not normalise, correct or substitute input for a dataset whose
`expectedStatus` is 400 or above. Each of these was a real bug in which the
harness deleted the thing under test and then blamed the endpoint:

| repair | what it destroyed |
|---|---|
| credential substitution on login | "reject a wrong password" received the **correct** password → 200 |
| path params read from `testCases[0]` | "reject a non-UUID id" received a **valid** id → 200 |
| query params read from `testCases[0]` | negative filters were never sent |
| `from`/`to` reordering | "reject a window whose end precedes its start" was **reordered into a valid range** → 200 |

If a negative dataset fails, check what was actually sent before concluding the
API is wrong. `run-dev-tests.sh --datasets all` reports each dataset's request.

### Verifying

```bash
./run-dev-tests.sh --datasets all          # every dataset, not just the producer
./run-dev-tests.sh --status                # summary, failures separated from skips
```

The run log names the layer that supplied each header, so a surprising identity
can be traced to the layer that set it rather than guessed at.

---

## Known issues

### ~~`projexlight_review_api_definitions` ignores `projectPath`~~ — FIXED 2026-08-08

Was: called with one project's path from another project's session, it reviewed
whichever project the container treated as current and reported success either way —
a clean report about a project you did not ask about, which is worse than an error
because nothing looks wrong.

**Root cause** (TK-4141): `projectId` was checked *first*, and the MCP bridge injects
its own `PROJECT_ID` on every single call — so `projectId` was always present and
`projectPath` could never decide anything. It was decorative on every endpoint that
resolved this way.

**Fixed:** an explicit **host** path now outranks the bridge-injected `projectId`. A
bare container mount slot (`/workspace`, `/projects/additionalN`) still defers to
`projectId`, because the same slot names a different project in a different container
and the git hook sends a bare `/workspace`.

**Verified 2026-08-08** from a ProjexCloud-rooted session: `projectPath` set to
LeadFlow resolved `[project=LeadFlow root=/projects/additional1]` and listed LeadFlow's
own resources (`intake`, `leads`, `sla`, `capture`, …); ProjexCloud's path resolved
`root=/workspace`, `resolvedBy=projectPath`. Both directions work from one container.

A missing scope is also no longer a silent pass: a subdir that does not exist under the
resolved root now raises 409 and prints the resource list actually present there, so a
wrong root announces itself with the one fact that identifies it.

**Still true and worth checking:** confirm the `root` in the tool's own output. It is
now reported on every response (`scope.root`, `scope.projectName`, `scope.resolvedBy`).

## Cheat sheet

```bash
# Start all services (database + Dev MCP + Test MCP)
cd mcp-server && ./setup-all.sh

# Start Dev MCP only
./setup-dev-mcp.sh start

# Health check
curl http://localhost:8766/health

# Tail logs
./setup-dev-mcp.sh logs

# Restart after config change
./setup-dev-mcp.sh restart

# Check status
./setup-dev-mcp.sh status

# Check hook installation
curl http://localhost:8766/hooks/status

# Reinstall hooks
curl -X POST http://localhost:8766/hooks/install

# Manually run a test sweep (full mode, bypasses incremental filter)
curl -X POST http://localhost:8766/api/test \
  -H 'Content-Type: application/json' \
  -d '{"projectPath": "/workspace", "api_test_mode": "full"}'

# Check SUT reachability from inside the container
docker exec projexlight-dev-mcp curl -I http://host.docker.internal:3005/

# Stop Dev MCP
./setup-dev-mcp.sh stop

# Force restart all services
./setup-all.sh --force
```

---

## Related docs

- **[TEST_MCP.md](./TEST_MCP.md)** — Running UI and API tests from `run-all-tests.sh` (Test MCP, not Dev MCP)
- **[SUT_SETUP_GUIDE.md](./SUT_SETUP_GUIDE.md)** — Framework-specific commands to bind your SUT to `0.0.0.0`
- **[../README.md](../README.md)** — Top-level project overview and quickstart
