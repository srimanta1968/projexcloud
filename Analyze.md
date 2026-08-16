1. Why 23 definitions never reached the api_library

The registration is scoped to the commit delta and fails silently. From the code's own comment at server.py:6094:

▎ "Pass staged_files so registration is scoped to the current commit delta rather than the whole tests/api_definitions/ tree."

Two consequences combine badly:

- No reconciliation. A definition reaches the library only if it was in a commit whose hook ran successfully. Miss that window once and nothing ever retries — there's no "sync everything on disk" pass.
- Failure is a warning. server.py:6071 — else: logger.warning("⚠️ Failed to register: ..."). The commit proceeds, the developer sees nothing, and the gap is only visible in container logs that rotate.

I tested and rejected the obvious hypothesis: it isn't taskId. 14 of the 23 lack one, but so do 200 of the 707 that did register.

Tracing each missing file to its adding commit shows it's not one bad run — they're spread across 8 commits:

8 78db132 test(api-defs): author the 16 definitions the reviewer reported
6 428fd72 feat(platform): bulk decision endpoints, EMPI tenant scope
3 2ce2c8a feat(sdk-api-keys): per-app credentials, gateway key auth
2 361d639 feat(notification,persona): send-by-reference audience dispatch
…

The first line is the sharpest: a commit written specifically to author definitions the reviewer reported missing had 8 of them still fail to register. The gap-closing mechanism has the same leak as the thing it was closing.

2. MUST-60 and the 8 skipped

MUST-60 is about scaffold/placeholder definitions, and its last clause covers these: "a definition whose endpoint does not resolve to a REAL route in the current codebase (stale/removed route) must be pruned, not tested" — via is_active: false.

They are not one problem, and only some are fixable:

┌───────────────────────────────────────────────────┬───────────────────────────────────────────────────┬────────────────────────────────────────────────────────────┐
│ Endpoint │ Cause │ Fixable? │
├───────────────────────────────────────────────────┼───────────────────────────────────────────────────┼────────────────────────────────────────────────────────────┤
│ /api/build/plan ×2, /api/role-templates │ route genuinely doesn't exist │ No — prune. is_active:false per MUST-60 │
├───────────────────────────────────────────────────┼───────────────────────────────────────────────────┼────────────────────────────────────────────────────────────┤
│ /mcp/v1/call │ served by standalone registry-mcp, not the │ Config — needs a separate service base URL │
│ │ gateway │ │
├───────────────────────────────────────────────────┼───────────────────────────────────────────────────┼────────────────────────────────────────────────────────────┤
│ /api/commands/stream/:asset_id │ WebSocket upgrade (HTTP 101) │ No — an HTTP runner can't test it; mark testability: │
│ │ │ manual │
├───────────────────────────────────────────────────┼───────────────────────────────────────────────────┼────────────────────────────────────────────────────────────┤
│ /api/mcp/server-registrations/:id ×2 │ "no captured values for path params: ['id']" │ Yes │
├───────────────────────────────────────────────────┼───────────────────────────────────────────────────┼────────────────────────────────────────────────────────────┤
│ /api/empi/candidate-links/:link_id/steward-review │ tenant-isolation limit │ Needs a second tenant │
└───────────────────────────────────────────────────┴───────────────────────────────────────────────────┴────────────────────────────────────────────────────────────┘

On your env-var question: only /mcp/v1/call genuinely wants config. The two path-param ones should not use a variable — MUST-46 is explicit that an entity id via {{var:*_id}} is the antipattern; if a route creates the resource, the id must come from that producer via dependsOn + {{cache:}}. A {{var:}} is correct only where no route can create it.

And yes — there is an entry the LLM is supposed to make. That's MUST-78, which I added this session: writing {{var:NAME}} obliges the same edit to declare the slot in test-config.json plus a \_variable_meta entry saying what the value is and where to get it. Unset now means a skip naming the variable, not a confusing failure.

3. The 37 Test MCP failures

Both kinds fail, and the happy path fails more:

┌───────────────────────────┬───────┬────────┬───────────┐
│ │ Cases │ Failed │ Pass rate │
├───────────────────────────┼───────┼────────┼───────────┤
│ Happy path (2xx expected) │ 711 │ 21 │ 97.0% │
├───────────────────────────┼───────┼────────┼───────────┤
│ Error case │ 154 │ 16 │ 89.6% │
└───────────────────────────┴───────┴────────┴───────────┘

The 21 happy-path failures are mostly state/ordering, not broken endpoints — six are 409 Conflict (SLA clocks pause/resume/satisfy, appointment confirm, capability execute, profile update), i.e. the resource was already in the target state from an earlier case. Five are 404 on routes Dev already knows are absent. Two are 500.

The 16 error-case failures split revealingly:

- 11 got 2xx where a rejection was expected — the endpoint accepted input it should refuse
- 2 got 404 — route absent
- 3 other

But of those 11, the four expected=401 got=200 ones are false alarms, and this is the important correction: the case named "Reject a request with no admin ops token" sent the token. Local definition is correct (headers: []); defaultHeaders and providers in test-config are both empty. The api_library's copy of that case lost its empty-headers intent.
