# ProjexCloud SDK Backlog — P16

**Created:** 28 July 2026 · **Project:** ProjexCloud (`cf30e9b7`) · **Sprint:** Sprint3 (`d4876947`)
**Status:** Imported into ProjexLight — `EP-374` … `EP-385`, 46 features, 22 scenarios, `TK-4038` … `TK-4088`

Driven by the LeadFlow build (project `894bc4c8`, `EP-346` / `EP-351`), which is the first consumer. Every item here is **vertical-neutral by contract** — a CI gate fails any build that puts a vertical name, stage name, role name or business rule into package source.

---

## What was created

| Epic | SDK | Kind |
|---|---|---|
| EP-374 | `sdk-source-record` | **NEW** — provenance kernel: immutable source records, bitemporal assertions, origin class, P0–P4 trust ladder, source-rights attestation |
| EP-375 | `sdk-import` | **NEW** — governed import runs: preview, mapping templates, dry-run, exception file, atomic commit, rollback, lineage |
| EP-376 | `sdk-sla` | **NEW** — business-clock SLA: IANA calendars, escalation ladders, idempotent tick, breach reasons, attainment |
| EP-377 | `sdk-coverage` | **NEW** — schedules, PTO, holidays, presence, capacity, on-call, backup designation |
| EP-378 | `sdk-data-credits` | **NEW** — vendor-abstracted capability broker, reserve/settle/refund, cache, role budgets, ledger |
| EP-379 | `sdk-assignment` | Enhancement — six-step routing decision engine |
| EP-380 | `sdk-crm` | Enhancement — subject-generic NEXT-action, date-push log, close reasons, aging |
| EP-381 | `sdk-conversation` | Enhancement — omnichannel threading, reply linkage, compose guardrails |
| EP-382 | `sdk-parsing` + `sdk-projection` | Enhancement — contact extraction schemas, explainable survivorship, replay |
| EP-383 | `sdk-notification` + `sdk-rebac` + `sdk-lead-scoring` | Enhancement — frequency caps, bitemporal roles, B2B features |
| EP-384 | `sdk-connectors` | Enhancement — lead-form and web-chat source adapters |
| EP-385 | platform | Release engineering — publishing, catalog registration, consumption contract, neutrality gate |

The five NEW packages were confirmed absent from `packages/` before planning. Note `sdk-capability` is CLI scaffolding, not a runtime broker — `sdk-data-credits` does not duplicate it.

---

## Overlap decisions

Three planned epics collided with existing P14/P15 work. Each was **rescoped to the delta** rather than duplicated:

| Existing | Covers | Rescoped epic |
|---|---|---|
| **EP-335** (P14·E5) | sdk-assignment rotation strategy & cursor | **EP-379** excludes rotation; consumes it. Keeps the decision pipeline, assignment lifecycle and simulation |
| **EP-334** (P14·E4) | sdk-crm stage guard, NEXT-action enforcement, pipeline enrichment; sdk-notification inbound & send routing | **EP-380** excludes those; delta is generalisation to any `subject_ref`, date-push log, close-reason taxonomy, stage aging. **EP-383**'s notification feature is scoped to frequency caps and the dedup window only |
| **EP-340** (P15·E5) | sdk-connectors DLQ, sdk-crm call activity | **EP-384** excludes the DLQ; delta is the adapter set, which consumes that DLQ for failure handling |

---

## Files here

- `epics-features-scenarios.json` — the imported epic/feature/scenario payload (record of what was created)
- `tasks.json` — the imported task payload, keyed by `feature_temp_id` / `epic_temp_id`

Both retain temp IDs. To re-import into a fresh project, run epics → features → scenarios in order, carrying each step's `id_mapping` forward, then substitute the mappings into `tasks.json` before bulk task creation. The epic importer **deduplicates on `source_module`**, so keep those unique.

---

## Build order

`EP-374` and `EP-377` first (they are dependencies): `sdk-source-record` feeds `sdk-import`; `sdk-coverage` feeds `sdk-assignment` step 4 and `sdk-sla` late-coverage. Then `EP-375`, `EP-376`, `EP-378`. Enhancements `EP-379`–`EP-384` can run in parallel. `EP-385` closes the batch and is what makes any of it consumable by a vertical.
