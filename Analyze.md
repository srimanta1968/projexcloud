Here are the defects, written as task input. All verified read-only in C:\Users\srima\projex_verticals\ProjexCloud — nothing was modified there.

---

1. sdk-catalog.json was never regenerated — the SDKs are undiscoverable

File: mcp-server/data/sdk-catalog.json (and sdk-catalog-index.json)

Evidence: Catalog is version 2026.07.21, sdk_count 67, api_count 469 across 9 groups. It contains zero occurrences of source-record or imports/runs — both SDKs postdate it. Confirmed against the resolver, not inferred: projexlight_get_sdk_api for POST /api/source-records returns found:false with no near-matches.

Why it matters: All 27 endpoints across sdk-source-record and sdk-import are invisible to SDK-reuse discovery. A developer on the next vertical asking the catalog whether governed import or provenance capture already exists is told to build it as custom code — which is precisely the cost the upstream contribution existed to eliminate.

Done when: Both SDKs appear in sdk-catalog.json and sdk-catalog-index.json with their endpoints and reuse_when keywords, and get_sdk_api resolves POST /api/source-records and POST /api/imports/runs.

---

2. Embedded placeholders break re-runnability and collide with UNIQUE constraints

Files: tests/api_definitions/imports/runs-post.json, mapping-templates-post.json, runs-run_id-commit-post.json, runs-run_id-dry-run-post.json

Evidence:
"file_fingerprint": "fp-{{dynamic:uuid}}" runs-post.json:94
"file_name": "contacts-{{dynamic:slug}}.csv" runs-post.json:96
"slug": "contacts-{{dynamic:slug}}" mapping-templates-post.json:57
"external_id": "CRM-{{dynamic:uuid}}" commit + dry-run

Per the project's own MUST-16 / MUSTNOT-13 and the COMMON_MISTAKES.WRONG_embedded entry, a placeholder resolves only when it is the complete field value. Embedded in surrounding text it is transmitted literally.

Why it matters: Every run posts the identical string fp-{{dynamic:uuid}}, which collides head-on with UNIQUE (tenant_id, file_fingerprint, source_kind) declared in that SDK's own 001_init_import.sql:158. First run creates the row, second fails with unique_violation. external_id lands in id_crosswalk's UNIQUE (tenant_id, external_system, external_id) the same way. This is exactly the case MUST-47 warns about.

Caveat — this is rule-derived, not reproduced. The LeadFlow-bound MCP cannot execute ProjexCloud's definitions, so I read the rule rather than watching it fail. Worth one runner confirmation before fixing.

Fix: Make the placeholder the whole value — "file_fingerprint": "{{dynamic:uuid}}".

---

3. sdk-projection's test suite reports green having asserted nothing

Files: packages/sdk-projection/tests/survivorship.integration.test.ts, replay.integration.test.ts, .github/workflows/ci.yml

Evidence: beforeAll runs SELECT 1 FROM projection.survivorship_rule LIMIT 1; on any failure it sets dbUp = false and returns. Every test body then begins if (!dbUp) return; — and a test that returns early passes. CI provisions Postgres, but ci.yml runs only Install → Build → Lint → Test with no migration step, and neither the suite nor its vitest config applies migrations. So the table doesn't exist and the entire suite is green without executing.

Why this is the worst of the three: A skipped test is visible in the output. A silently-returning one is indistinguishable from a passing one. This covers the replay determinism, survivorship reasons and retract-triggers-replay logic — all well written, none of it running.

Done when: Migrations are applied in CI before the test step, and the bootstrap fails loud when the schema is absent instead of flipping a flag.

---

4. The DB-backed suites never run in CI

Evidence: SOURCE_RECORD_IT appears only in packages/sdk-source-record/tests/provenance.integration.test.ts. IMPORT_IT appears only in the sdk-import test files. No workflow under .github/workflows/ (6 files) sets either.

Why it matters: This is the strongest evidence in the whole upstream block and none of it executes — including a test proving the dry-run connection actively refuses an attempted write (so the zero-write guarantee isn't vacuous), the interrupted-commit retry, the rollback refusal naming its blocking action, and per-transition audit counts with verifyChain.

Good news: CI already provisions Postgres 16, so the blocker is one env var, not missing infrastructure.

---

5. CI tests against Postgres 16; the platform runs 18

File: .github/workflows/ci.yml:14 → image: postgres:16-alpine

The platform database is PostgreSQL 18.4 (projexlight/postgres-18-postgis-pgvector:local). CI also uses plain postgres, without PostGIS or pgvector. Any behaviour differing across majors, or any use of those extensions, is untested. Worth aligning while you're in that file for #3/#4.

---

6. 82 documented error cases, zero executable ones

Evidence: Across all 27 definitions — 39 errorCases in source-record, 43 in imports — there are zero testCases carrying testType: "negative", and no file declares coversCriterion.

Per MUST-64/MUST-67, errorCases alone is documentation that no runner ever executes; per MUST-69, without coversCriterion the endpoints are untraceable coverage and a reviewer reports the criterion as a gap even though the test exists.

---

7. Four specific missing tests

┌─────────────────────────────────────┬───────────────────────────────────┬─────────────────────────────────────────────────────────────────────┐
│ Guarantee │ Where it's enforced │ Status │
├─────────────────────────────────────┼───────────────────────────────────┼─────────────────────────────────────────────────────────────────────┤
│ Migrations re-run cleanly │ 001_init_source_record.sql │ Idempotent by inspection; nothing executes a second application │
├─────────────────────────────────────┼───────────────────────────────────┼─────────────────────────────────────────────────────────────────────┤
│ raw_evidence/origin_class immutable │ reject_capture_mutation() trigger │ Trigger exists; no test attempts the rejected UPDATE │
├─────────────────────────────────────┼───────────────────────────────────┼─────────────────────────────────────────────────────────────────────┤
│ Mapping template frozen once used │ reject_used_template_mutation() │ No test at all — grep for mapping_template in tests returns nothing │
├─────────────────────────────────────┼───────────────────────────────────┼─────────────────────────────────────────────────────────────────────┤
│ Extraction persists nothing │ sdk-parsing │ Proposal shape pinned down; nothing asserts zero writes │
└─────────────────────────────────────┴───────────────────────────────────┴─────────────────────────────────────────────────────────────────────┘

---

8. Capture-to-projection has no end-to-end test

No test in sdk-source-record/tests imports sdk-projection, and none in sdk-projection/tests imports sdk-source-record. Each SDK is tested in isolation, so the seam between assertions and survivorship is unexercised — and that seam is where link-over-merge, this epic's central claim, actually lives. import-to-rollback does exist as one flow; capture-to-projection does not exist at all.

---

9. Packaging is configured but not done

publishConfig is present on all four packages, but the Verdaccio registry at http://localhost:4873 is unreachable (curl returns nothing), so nothing is installable from it. sdk-source-record and sdk-import are still at 0.1.0, which reads as pre-release to any semver consumer. The LeadFlow consumption contract document (which SDK owns which table, what an app may extend locally) does not exist in either docs tree — ProjexCloud/docs/api_docs/contracts.html is generated API reference, not that document.
