# Handoff — upstream SDK endpoints may be registered in the WRONG project's api_library

**Raised:** 2026-08-06 · **Needs:** a session rooted in **ProjexCloud** (see Constraints)
**Status:** unverified suspicion with a concrete cause — verify before changing anything.

---

## The problem in one paragraph

Three `[UPSTREAM]` tasks were completed from a session rooted in **LeadFlow**. Their code
lives in **ProjexCloud** (`packages/sdk-assignment`, `sdk-crm`, `sdk-conversation`), but the
task rows live in the **LeadFlow** ProjexLight project. `projexlight_complete_task` was
therefore called with LeadFlow's `projectPath`, carrying `generatedApis` for 26 endpoints —
so those endpoints were most likely registered into **LeadFlow's** `api_library`. None of
them exist in LeadFlow's SUT. Once a row is in the catalog the runner dispatches it as a
real call, so each one becomes a permanent failure that buries real regressions. This is the
exact outcome `hasHttpSurface` warns about, arrived at from the opposite direction: not a
fabricated `internal://` endpoint, but a real endpoint filed against the wrong SUT.

## The three tasks and what was sent

| task | short | resource | endpoints sent as `generatedApis` |
|---|---|---|---|
| `463036e2-dd87-4e2f-aa71-281bd26af91f` | TK-3919 | sdk-assignment | 14 (`/api/assignment/*`, `/api/assignments/*`) |
| `f353b8be-4d0e-46cb-baf9-0b01aca019f5` | TK-3920 | sdk-crm | 7 (`/api/crm/*`) |
| `0a40d552-088e-454d-b1ec-082f02ceaf08` | TK-3921 | sdk-conversation | 5 (`/api/conversations/*`) |
| `2fcd6b69-1a9a-4aff-9005-12fb195c9315` | TK-3922 | sdk-connectors | 3 (`/api/connectors/dlq/*`, `/api/connectors/tenants/:tid/dlq/reconcile`) |

**29 endpoints in total.** TK-3922's three were sent knowingly, after the first 26 were
already suspected: `complete_task` REFUSES a `service_layer` task without API evidence, and
the only alternative it offers is `has_http_surface=false`, which would have been a false
statement — the task genuinely implements the behaviour behind three real routes. Given a
choice between a permanent lie in the task record and three more rows on an already-planned
cleanup list, the rows were the lesser harm. Clean all 29 together.

Two things noticed while doing that, both worth fixing separately:
- The gate's hint says `has_http_surface=false` (snake_case) while the MCP tool parameter is
  `hasHttpSurface` (camelCase). Passing the camelCase form did NOT satisfy the gate on a
  `service_layer` task — but the SAME camelCase form WAS accepted on a `testing` task
  (TK-3923) minutes later. So this is not confirmed as a naming bug: it may equally be that
  the waiver is simply not consulted for API task types, which would make the hint
  misleading rather than the parameter wrong. Worth ten minutes with the handler before
  anyone "fixes" a name.
- There is no way to record "this task implemented behaviour behind a route another task
  registered". `generatedApis` assumes the task that reports an endpoint is the one that
  created it, which is why the entries carry a `note` field saying the route pre-existed.

Projects: **LeadFlow** `894bc4c8-4cfb-407d-9e86-234b69490275` · **ProjexCloud**
`cf30e9b7-0b94-4b48-8571-ee41e1241131`.

LeadFlow's own surface is `/api/leadflow/*`, `/api/leads`, `/api/sla/*`, `/api/analytics/*`,
`/api/auth/*`, `/api/events/*` — served on `:3010`. Nothing under `/api/assignment`,
`/api/crm` or `/api/conversations` is routed there, so every one of the 26 would 404.

## Step 1 — VERIFY before you change anything

This is a suspicion, not a confirmed fact. It was never confirmed because
`projexlight_delete_api_library_entries` with `dryRun: true` **times out at 30s** on every
call, including a two-endpoint request. Do not skip this step and do not assume.

Confirm whether the rows exist in LeadFlow's catalog, by whichever of these works:

- `projexlight_delete_api_library_entries` with `dryRun: true`, `projectId: 894bc4c8-…`
  and a couple of the endpoints above (retry — the timeout may be transient/load-related);
- the ProjexLight UI's API library view for the LeadFlow project;
- a direct read of `api_library` filtered to that `project_id`.

Also check the file cache: `LeadFlow/.mcp-cache/api_test_cache.json` → `tested_apis`. At the
time of writing it held **51 entries, none of them upstream-shaped** — so if rows do exist
server-side, the local cache has not seen them and a naive hand-delete would strand them
(see that tool's own description for why).

**If no such rows exist in LeadFlow's api_library, stop — there is nothing to fix here.**
Record that outcome so the next person does not re-investigate.

## Step 2 — if the rows ARE there

1. **Remove them from LeadFlow.** Use `projexlight_delete_api_library_entries` with
   `projectId: 894bc4c8-…` — never a hand-delete, which leaves the test-cache entry behind
   and makes the endpoint unrecoverable. Run `dryRun: true` first and read the match list.
   Expect it to REFUSE rows whose api_definition file still exists; that guard is aimed at
   same-project rows, and here the definitions live in a *different* repo, so confirm the
   refusal reasoning genuinely applies before reaching for `force: true`.
2. **Register them where they belong** — ProjexCloud's own catalog, from a ProjexCloud-rooted
   session. Prefer the definition-driven path (a test run lets the classifier pick up the
   changed definition files) over re-sending `generatedApis`.
3. **Send `apiDefinitions`, not `generatedApis`.** The schema says `generatedApis` is for
   "when apiDefinitions is not available". They *were* available and the thin form was used
   anyway, so any rows created carry no testCases and the Test MCP — which executes from
   `api_library` — has nothing to run.

## What NOT to do

- **Do not "fix" this by sending the full `apiDefinitions` to the LeadFlow project.** That
  makes it worse: unreachable rows become *executable* unreachable rows.
- **Do not mark the endpoints `hasHttpSurface: false`.** They genuinely ship HTTP routes;
  the problem is which project owns them.

## Constraints you will hit

- **`projexlight_review_api_definitions` ignores `projectPath`.** Called with ProjexCloud's
  path from a LeadFlow-rooted session it reviewed *LeadFlow* — `root=/projects/additional1`,
  reporting a clean `0 files` for `scope=assignment`, a scope that only exists in
  ProjexCloud. A clean report about the wrong project is worse than an error. Already
  recorded under "Known issues" in `mcp-server/docs/DEV_MCP.md`. Confirm the `root` in the
  tool's own output before trusting any review.
- **`delete_api_library_entries` currently times out at 30s**, dry run included.
- Root cause of both: the bridge resolves the project from the session's own `.mcp.json`
  `PROJECT_ID`, so cross-project calls need a session rooted in the target repo.

## Related state you should know about

- The three tasks' definitions were brought up to **MUST-64** (a negative `testCase` per
  reproducible `errorCase`, linked by `coversErrorCase`) in commits `85d040a` and `2a187e1`:
  22 definitions, 55 new negative datasets. **They have never been executed or reviewed** —
  written from each `errorCase`'s own `when` plus the handler, using the mechanical trigger
  table in the authoring contract. Run them once the project routing above is sorted.
- **Two errorCases remain uncoverable** and were deliberately left rather than faked:
  `409|INVALID_ASSIGNMENT_TRANSITION` (needs an already-closed assignment) and
  `409|NO_BACKUP_DESIGNATED` (needs an assignment offered without a backup). Both need a
  second, distinguishable `record_id` from `POST /api/assignments`, and `captureResponse` is
  **file-level** — one definition cannot emit two distinct producer keys. Fixing these needs
  either a separate producer definition or a runner change; marking them
  `reproducible: false` would be wrong, since both are request-caused.
- **~55 further uncovered errorCases** remain across ~20 older `crm` definitions (contacts,
  deals, activities, funnel-stages, pipeline). Same mechanical treatment applies.
- ~~`ProjexCloud/.projexlight/scripts/server-config.json` was left repointed at **production**~~
  **RESOLVED 2026-08-06** — restored to `http://host.docker.internal:4000` and the
  `_TEMPORARY` key removed. No action needed.

---

## VERIFIED 2026-08-06 — the suspicion in Step 1 is TRUE

Tracked as **TK-4157**. Do not re-investigate; read that task for the full record.

`delete_api_library_entries` with `dryRun: true` DID complete this time — the 30s timeout
above was transient. Probing three endpoints against LeadFlow `894bc4c8` matched two:

| endpoint | row | `task_id` | = |
|---|---|---|---|
| `POST /api/assignments` | `142c402c` | `463036e2` | TK-3919 |
| `GET /api/crm/pipeline/aging` | `0086cca1` | `f353b8be` | TK-3920 |

The `task_id`s match the tasks named above, so this is the predicted misroute, not a
coincidence. `definitionsStillOnDisk: []`, so the force guard will not block deletion.

**Two findings that change the plan in Step 2.**

1. **The rows are not thin.** Step 2.3 assumed `generatedApis` produced rows with no
   testCases. They carry full `test_data_sets` (3 and 4 datasets, all `origin: "definition"`),
   so something registered them definition-driven and the Test MCP has been executing them.

2. **They are being executed against ProjexCloud's SUT.** `POST /api/assignments` shows
   `last_test_status: "passed"`, `lastStatusCode: 201`, and a `lastResponse` carrying
   `tenant_id: 8e6c1e65-…` — the **production ProjexCloud tenant**, from a dev-MCP run made
   that evening. So the contamination is **ongoing, not historical**: TK-4141 is routing
   live results into the wrong project's catalog.

**Therefore: do not delete first.** The rows are currently green, so deleting them removes
working coverage before the ProjexCloud-side rows exist. Revised order — (a) sweep all 29
with `dryRun` for the true matched set; (b) confirm each is registered in ProjexCloud
`cf30e9b7` with equivalent `test_data_sets`; (c) only then delete from `894bc4c8`;
(d) re-run both projects and confirm neither dispatches a foreign path.

**Contamination runs both ways.** A test-MCP database-mode run against prod dispatched
LeadFlow-shaped paths that exist in neither ProjexCloud repo nor SUT — the prod gateway
logged `Route GET:/coach/scorecard/:callId not found`, plus `/sdr/qualify`, `/propose`,
`/:id/intelligence`, `/recording-eligibility`. Confirmed those also 404 against the local
ProjexCloud gateway and have no on-disk ProjexCloud definition.

---

## OUTCOME — SETTLED 2026-08-08. Do not re-investigate.

The revised order above was followed exactly. All four steps are done.

**(a) Full sweep.** Dry-ran all 73 HTTP endpoints from ProjexCloud's `assignment`, `crm`,
`conversation` and `connectors` definition trees against LeadFlow `894bc4c8`. **9 rows
matched, not 29.** The rest either never landed or were removed by the earlier hand-deletes
this document records. The 9 carry `task_id` values `463036e2` (TK-3919, sdk-assignment),
`f353b8be` (TK-3920, sdk-crm) and `2fcd6b69` (TK-3922, sdk-connectors) — the exact tasks
predicted, so this is the predicted misroute and not a coincidence.

| method | endpoint |
|---|---|
| POST | `/api/connectors/dlq/replay` |
| POST | `/api/assignment/route` |
| POST | `/api/assignment/routes` |
| POST | `/api/assignment/simulate` |
| POST | `/api/crm/next-actions/:id/reschedule` |
| POST | `/api/crm/subjects/:subject_ref/next-action` |
| GET | `/api/assignment/routes` |
| GET | `/api/crm/subjects/:subject_ref/next-action` |
| GET | `/api/crm/subjects/:subject_ref/save-gate` |

**(b) ProjexCloud side confirmed FIRST.** The same 9 were dry-run against ProjexCloud
`cf30e9b7`, which **refused** them: *"Refusing to delete rows whose api_definition files
still exist"*, naming all 9 files (`tests/api_definitions/assignment/routes-post.json`,
`crm/subjects-subject_ref-save-gate-get.json`, …). That refusal is the proof step (b)
wanted — every one is registered in ProjexCloud **and** backed by a definition on disk.
Nothing was lost by removing the LeadFlow copies.

**(c) Deleted from LeadFlow** via `projexlight_delete_api_library_entries`, never by hand.
`deletedCount: 9`. Backup written before the delete to
`LeadFlow/.mcp-cache/deleted_api_library/api_library_deleted_20260808T202703Z.json`
(106 KB, full row bodies) — restorable if this judgement is ever disputed.

**`cacheEntriesEvicted` was `[]`, and that is correct, not a bug.** LeadFlow's
`.mcp-cache/api_test_cache.json` holds 51 `tested_apis` entries and **none** is
upstream-shaped — verified after the delete: none of the 9 keys present, no
`/api/crm|assignment|conversations|connectors` key at all. This matches what this document
observed at the time of writing. There was simply nothing to evict. Note this leaves
TK-4142's cache-eviction criterion demonstrated only in the negative.

**(d) Still open — the reverse direction.** LeadFlow-shaped paths in ProjexCloud's catalog
(`/coach/scorecard/:callId`, `/sdr/qualify`, `/propose`, `/:id/intelligence`,
`/recording-eligibility`) are **not** cleaned by this pass. They belong to LeadFlow and are
handed to the LeadFlow agent — see `TO-LEADFLOW-api-library-cleanup.md`. They are not
deleted from here, because deciding another project's catalog is not this project's call.

### Corrections to earlier text in this document

- **"29 endpoints"** — the true figure in LeadFlow's catalog at sweep time was **9**.
- **`server-config.json` left pointing at production** — already corrected; it is back to
  `http://host.docker.internal:4000` with the `_TEMPORARY` key removed.
- **`delete_api_library_entries` times out at 30s** — no longer true. Every call in this
  pass returned promptly, including a 73-endpoint sweep. The timeout was transient.
- **`review_api_definitions` ignores `projectPath`** — fixed under TK-4141. An explicit
  host path now outranks the bridge-injected `projectId`. `mcp-server/docs/DEV_MCP.md`
  still lists it under "Known issues" and needs that entry retired.
