# Finding — sdk-crm and sdk-lead-scoring carry funnel vocabulary in executable code

**Raised:** 2026-08-06 (TK-3923) · **Needs:** a product decision before a gate can be written

Eight packages were missing the vertical-neutrality gate that TK-3923's AC3 requires
across "every new and extended package". Six were added in `eb0c160`. These two were
deliberately left out, because a gate written for them **fails today** — and weakening the
ban list to make it pass would have produced a green test guarding nothing.

## sdk-crm — a five-stage funnel is pinned in code and in DDL

| where | what |
|---|---|
| `src/db/migrations/001_init_crm.sql:34` | `CHECK (stage IN ('qualifying','proposal','negotiation','closed-won','closed-lost'))` |
| `src/models/crm.model.ts:2` | `export type DealStage = 'qualifying' \| 'proposal' \| 'negotiation' \| 'closed-won' \| 'closed-lost'` |
| `src/server/routes.ts:62` | `const STAGES: DealStage[] = [...]` |
| `src/services/crmService.ts:301` | `AND stage NOT IN ('closed-won','closed-lost')` |

71 ban-list hits in total, dominated by these. A pipeline's stage names are the definitive
vertical-specific value — a field-service tenant has no "proposal" or "negotiation" — and
the criterion says every vertical-specific value must arrive as configuration.

**This is not a simple bug.** Migration `002_crm_funnel_stages.sql` already added a
configurable `crm.funnel_stage` table and `deal.funnel_stage_id`, so the configurable
mechanism EXISTS. The hardcoded enum and CHECK are the legacy path, kept deliberately: the
sibling criterion on TK-3922 is "additive with no breaking change to existing endpoints",
and dropping `DealStage` would break every caller still sending it.

So there is a real tension between two criteria, and it needs a decision rather than a
patch. Roughly:

1. **Deprecate and migrate** — move existing rows onto `funnel_stage_id`, keep `stage` as a
   generated/compat column for a release, then drop the CHECK. Most work, resolves it.
2. **Scope the gate** — write the neutrality test to scan everything EXCEPT the declared
   legacy compatibility surface, listing those four sites explicitly so the exception is
   visible and cannot silently grow. Cheap, honest, and it still guards new code.
3. **Accept** — record that sdk-crm is a CRM-shaped package whose stage vocabulary is
   considered platform-generic, and write no gate. Weakest, but it is a legitimate call
   someone can make; it should be written down rather than left implicit.

Option 2 is the smallest change that makes the rule enforceable again, and it does not
foreclose option 1.

## sdk-lead-scoring — `nurture` is an enum value, not configuration

| where | what |
|---|---|
| `src/services/scoringEngine.ts:237` | `\| 'nurture';` — part of the next-best-action union |
| `src/services/scoringEngine.ts:285,316` | `action: 'nurture'` |
| `src/services/scoringEngine.ts:286,317` | `reason: 'all subscores zero — keep in nurture queue'` |
| `src/services/scoringEngine.ts:270` | `// Storm impact dominates ... that's a hot lead` |

`nurture` is funnel vocabulary sitting in a type union and in returned literals, so it is
shipped behaviour rather than tenant configuration. Smaller and more tractable than the crm
case: the action vocabulary could be renamed to something neutral (`defer`, `hold`,
`low_priority`) or made configurable, with the funnel word supplied by the caller.

The remaining hits in this package are fine and should NOT be "fixed": `insurance` appears
in `/** Contact persona kinds (e.g. ['homeowner','insurance-claimant']) */`, which is a
doc example of caller-supplied data, and `healthcare` in a migration comment explaining
*why* weights are configurable ("FieldOps / Realty / Healthcare weight features
differently") — that comment argues FOR neutrality.

## Once decided

Add `tests/neutrality.test.ts` to each package following the six committed in `eb0c160`.
Copy the structure, not the ban list: each of those six tailors its terms and records every
exclusion with the reason, because a gate that cries wolf gets suppressed and a suppressed
gate protects nothing. Keep both invariants — the guard that an empty scan cannot read as a
pass, and the self-check that plants a term per category so a broken matcher is caught.
