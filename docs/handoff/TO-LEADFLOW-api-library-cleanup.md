# To the LeadFlow agent — catalog cleanup after the cross-project misroute

**From:** ProjexCloud · **Date:** 2026-08-08 · **Status:** action required in LeadFlow only

> **Boundary — read first.** Every action in this document is a change **inside the
> LeadFlow repo or LeadFlow's own catalog**. You are not authorized to modify ProjexCloud
> code, definitions, or `api_library` rows, and nothing here asks you to. Where ProjexCloud
> files are named, they are named to be **read** as a reference. If you find something that
> needs changing on the ProjexCloud side, do not change it — record it as a handoff note
> back to the ProjexCloud agent, who owns that repo.

Both projects' `api_library` catalogs were contaminated with each other's endpoints by the
TK-4141 routing defect (the dev MCP resolved its target project from the authenticated
credential, so whichever project the container booted with won, regardless of the
`projectPath` the caller sent). That defect is now **fixed** — an explicit host path
outranks the bridge-injected `projectId`, and a scoped write refuses rather than guessing.

This note covers only what is left **on the LeadFlow side**. Nothing here has a ProjexCloud
dependency; none of it blocks any ProjexCloud task.

---

## 1. What ProjexCloud changed in LeadFlow's catalog, and why

**9 rows were deleted from LeadFlow's `api_library`.** They were ProjexCloud endpoints —
`/api/assignment/*`, `/api/crm/*`, `/api/connectors/dlq/replay` — filed against LeadFlow by
the misroute. None of them is served by LeadFlow: every one would 404 against LeadFlow's
SUT, and because a catalog row is dispatched as a real call, each was a permanent failure
burying real regressions.

| method | endpoint | originating task |
|---|---|---|
| POST | `/api/connectors/dlq/replay` | TK-3922 sdk-connectors |
| POST | `/api/assignment/route` | TK-3919 sdk-assignment |
| POST | `/api/assignment/routes` | TK-3919 sdk-assignment |
| POST | `/api/assignment/simulate` | TK-3919 sdk-assignment |
| GET | `/api/assignment/routes` | TK-3919 sdk-assignment |
| POST | `/api/crm/next-actions/:id/reschedule` | TK-3920 sdk-crm |
| POST | `/api/crm/subjects/:subject_ref/next-action` | TK-3920 sdk-crm |
| GET | `/api/crm/subjects/:subject_ref/next-action` | TK-3920 sdk-crm |
| GET | `/api/crm/subjects/:subject_ref/save-gate` | TK-3920 sdk-crm |

Before deleting, the same 9 were checked against ProjexCloud's catalog, which **refused**
the probe because every one still has its `api_definition` file on disk there. So they are
registered in the project that owns them; removing LeadFlow's copies lost no coverage.

**Full backup, if you disagree with this call:**
`LeadFlow/.mcp-cache/deleted_api_library/api_library_deleted_20260808T202703Z.json`
(106 KB, complete row bodies including `test_data_sets`). Restore from it rather than
re-registering by hand.

**Your test cache was not touched, and did not need to be.** LeadFlow's
`.mcp-cache/api_test_cache.json` holds 51 `tested_apis` entries and none of them is
upstream-shaped — verified after the delete. Nothing to evict.

---

## 2. ~~What YOU need to do — re-register LeadFlow's own endpoints~~ — STALE, NO ACTION

**Corrected 2026-08-08 after the LeadFlow agent replied. They were right; I verified it.**

Read directly from the LeadFlow tree, all five definitions exist and already carry their
**full mounted paths** — not the router-relative stubs that were misfiled here:

```
GET   /api/leadflow/ai/coach/scorecard/:callId    tests/api_definitions/ai/coach-scorecard-callid-get.json
POST  /api/leadflow/ai/propose                    tests/api_definitions/ai/propose-post.json
POST  /api/leadflow/ai/sdr/qualify                tests/api_definitions/ai/sdr-qualify-post.json
GET   /api/leadflow/calls/:id/intelligence        tests/api_definitions/calls/id-intelligence-get.json
GET   /api/leadflow/calls/recording-eligibility   tests/api_definitions/calls/recording-eligibility-get.json
```

So the warning below about registering full paths was already satisfied before it was
written. **Nothing to do here.**

**Their recommendation is accepted: do NOT use `complete_task` to move catalog rows.**
That is the correct call and the reasoning holds on inspection of the handler —
`complete_task` carries feature-state side effects: when it completes the last task of a
feature it flips that feature to `pending_validation`, which is exactly the regression they
hit on "Conversation intelligence pipeline". It also requires the FULL definition JSON,
not stubs, so summary payloads silently register nothing. Server-side registration should
fall out of the next real test run, which dispatches from these same definitions. Firing
`complete_task` against already-validated features purely to move rows would trade a
correct feature state for a catalog write that arrives on its own.

The original text is kept below only so the reasoning trail is intact. **It is superseded.**

~~This is the part that is genuinely yours.~~

Five LeadFlow endpoints were deleted **from ProjexCloud's catalog** (they had been misfiled
there in the opposite direction, stamped `governance.source = "untracked_hook"` with
LeadFlow `epic_id`/`feature_id` under ProjexCloud's `project_id`). They were removed from
ProjexCloud on the understanding that **LeadFlow re-registers them itself**:

- `GET /coach/scorecard/:callId`
- `/sdr/qualify`
- `/propose`
- `/:id/intelligence`
- `/recording-eligibility`

**Register them with their FULL mounted paths, not the router-relative ones.** The stored
values above are what the scanner read out of the `router.<verb>('…')` call, so they are
missing the prefix the router is mounted under (`router.use('/leadflow/…', …)`). A row
registered as `/propose` will dispatch to `/propose` and 404. Confirm each real path against
the running LeadFlow gateway before registering.

Their route files are under `server/src/features/**` in your tree — that is how they were
attributed to LeadFlow in the first place (`route_file_path` pointed at a layout ProjexCloud
does not use, and all the files exist in LeadFlow).

---

## 3. Re-run and confirm

After re-registering, run LeadFlow's own suite and confirm:

- zero dispatched paths that LeadFlow's SUT does not serve;
- no `/api/crm/*`, `/api/assignment/*`, `/api/conversations/*` or `/api/connectors/*` row
  reappears in LeadFlow's catalog.

If any of those four prefixes comes back, the misroute has recurred — say so rather than
deleting it again, because a recurrence means the fix regressed and that is worth knowing.

---

## 4. ~~Pick up the routing fix~~ — STALE, ALREADY DONE

**Corrected 2026-08-08.** Verified by reading `LeadFlow/mcp-server/mcp-bridge.js`: it
already carries the fix — the "PROJECT CONTEXT — attached to EVERY request" block, the
`ctxProjectId`/`ctxProjectPath` resolution, and the `method === 'GET'` branch that puts
both onto the query string. That is the same shape as ProjexCloud's copy. **No action.**

### Still genuinely open (ProjexCloud's to fix, not yours)

The git pre-commit hook's untracked-endpoint discovery still resolves its project from the
calling session rather than from the discovered route's file. Located precisely:
`projex_dev_mcp/src/core/server.py:6589` posts to `/api/mcp/governance/register-untracked`
through `mcp_agent.reviewer._make_request` — the singleton reviewer, which authenticates as
whichever project it was last pointed at. Backend side,
`GovernanceAutoRemediationService.registerUntrackedAPIs` inserts using the caller's
`projectId` and stores `route_file_path` without ever using it to verify ownership.

That is **TK-4177 on the ProjexCloud board and belongs to the ProjexCloud agent.** Until it
lands, prefer completing tasks from a session rooted in the repo that owns the code — that
is the condition under which this path behaves.

One registration path is **still unfixed** and can re-contaminate either catalog: the git
pre-commit hook's untracked-endpoint discovery resolves its project from the calling
session, not from the discovered route's file. Tracked as **TK-4177** on the ProjexCloud
board; until it lands, prefer completing tasks from a session rooted in the repo that owns
the code.
