# sdk-identity-resolver: three routes missing from the manifest, and one metric that does not exist

**From:** LeadFlow · **Date:** 2026-08-10 · **Re:** building FT-1283, the Identity Review steward queue

Two findings from integrating against EMPI. The first is a documentation defect with real
consequences; the second is a genuine gap that leaves an acceptance criterion half-met on my
side, and I would rather tell you than quietly invent a number.

---

## 1. `sdk-capability.json` omits the entire EMPI surface

`packages/sdk-identity-resolver/sdk-capability.json` declares exactly two endpoints:

```
POST /api/resolver/resolve
POST /api/resolver/explain
```

`packages/sdk-identity-resolver/src/server/routes.ts` mounts **seven**. These five are absent
from the manifest:

| method | path | line |
|---|---|---|
| GET | `/api/empi/candidate-links` | `routes.ts:63` |
| POST | `/api/empi/candidate-links/:link_id/steward-review` | `routes.ts:85` |
| POST | `/api/empi/candidate-links/:link_id/adjudicate` | `routes.ts:109` |
| POST | `/api/empi/merges` | `routes.ts:128` |
| POST | `/api/empi/merges/:merge_id/unmerge` | `routes.ts:153` |
| GET | `/api/empi/metrics` | `routes.ts:171` |

**Why this is worse than a stale doc.** The manifest is the first thing anyone integrating
reads, and it is the only thing that reads as authoritative — a route absent from it looks
like a route that does not exist. My task instruction named `/api/empi/candidate-links` and
`/api/empi/metrics` explicitly, and when the manifest showed neither, the reasonable
conclusion was that the instruction was written against a plan that had not been built. I
only found otherwise by grepping your source, which is not a step an integrator should need.

It also has a cost you will pay directly: the whole of Epic 6 on my side — the candidate
review modal, risk-tiered auto-link policy, and link retraction with projection replay —
integrates against these six routes and `/api/projection/replay`. Every one of those tasks
starts by reading this manifest.

Nothing to fix in the code. Please add the six entries.

---

## 2. EMPI records no adjudication latency, and that half-blocks an AC

`EmpiMetrics` (`empiService.ts:390`) carries:

```ts
unresolved_candidate_links, merge_reversals, total_merges,
calibration_ece, confidence_distribution, drift_alert
```

FT-1283's mockup asks for six KPI tiles. **Three have no source in that shape:**

| tile | status |
|---|---|
| Review Cases (+ high-risk sub-count) | live — `unresolved_candidate_links` + `confidence_distribution` |
| Retracted Links | live — `merge_reversals` |
| Resolver Calibration | live — `calibration_ece` |
| Exact Auto-Links | **no source** — EMPI records only `POSSIBLY_SAME`; deterministic and crosswalk matches are linked without ever becoming a candidate link, so nothing counts them |
| Kept Separate ("this month") | **no source** — no count of rejected candidates, and no time-bounded counter at all |
| Median Review ("within the 15-minute SLA") | **no source** — no adjudication latency recorded anywhere |

My AC2 reads *"Median review time and calibration are live from EMPI metrics."* Calibration
is. Median review time cannot be, so I have shipped that criterion half-met and said so,
rather than reporting it green.

**I want to be explicit about the fake I refused**, because it is the obvious one and someone
will propose it: the median AGE OF OPEN CASES. It is trivially derivable from data I already
have, and it is worse than showing nothing — it reads as a service level while measuring its
inverse. A queue nobody has worked has a steadily rising median that would render as
*improving* review performance, and the number goes DOWN when a steward clears the backlog's
oldest cases, which is the moment they are working hardest. I have returned `null` with a
`metric_gaps` entry naming the reason, and the screen renders "Not measured".

**What would close it.** A latency metric keyed on the transition you already record —
`candidate_link.created_at` to the adjudication that settles it. `empi.candidate_link` carries
`created_at` and `updated_at`, and `adjudicateCandidate` is the single write that resolves a
case, so the measurement point exists; it is the aggregate that does not. A median and a p90
over a bounded window would serve both this tile and your own calibration reporting. Two
counters would also close Exact Auto-Links and Kept Separate, though those matter less to me.

No urgency from my side — the screen is honest without it. Raising it because you own the
model, and because "we cannot measure how long stewardship takes" is a gap worth someone
deciding about deliberately rather than inheriting.

---

## 3. Two things I need from you to finish Epic 6

### `PROJEXCLOUD_STEWARD_ROUTE_ID` — a decision cannot be recorded without it

`adjudicateCandidate` needs a `step_id`, which only `enqueueStewardReview` produces, which
requires a `route_id` — an sdk-approval route. LeadFlow has no value for one, so
`POST /api/leadflow/identity/candidates/:link_id/decision` currently answers **503
UPSTREAM_UNAVAILABLE** naming the missing setting, for every recorded verdict.

That refusal is deliberate and I would keep it even with a route configured: an *unrecorded*
adjudication is worse than a blocked one, because the case leaves the steward's queue looking
settled with no `merge_id` to reverse it by. But it does mean **no steward decision can be
recorded anywhere today.** Please provision a route for the `empi_candidate` subject kind and
send me the id.

### Nothing can create a candidate link, so the review modal is unreachable

This one blocks test evidence rather than function. Candidate links are raised inside your
probabilistic matcher; LeadFlow has no write path that produces one, and
`queryCandidateLinksByBand` returns empty here. The Identity Candidate Review modal opens from
a row's Compare action, so with an empty queue **the modal cannot be opened in any
environment we have.**

I have therefore NOT written UI scenarios for it. Scenarios asserting an evidence table and a
verdict block that cannot render would fail on every run, and syncing them would put four
permanently-red scenario records into the shared backlog — which is worse than an
acknowledged gap, because a red suite that is red for a known environmental reason trains
everyone to ignore it. Its two testable criteria (both records retained, decision recorded
with actor/reason/reversibility reference) are held by the api_definition instead, where they
are real assertions. The two presentation criteria — the per-feature evidence table and the
human-readable verdict — are unverified and I have said so rather than claiming them.

**A seeded candidate link in the QA EMPI would close this**, and it is the smaller ask of the
two: one `empi.candidate_link` row in `POSSIBLY_SAME` status with populated `provenance`
would make the modal reachable and let the evidence table be asserted against real shape
rather than sample data from a mockup.

## 4. Unrelated, still open

The consent point-read (`GET /api/consents/:receipt_id`) is still uncommitted working-tree
only — the endpoint 404s and my scorecard definition stays `testability: "manual"`. Ping me
when it is pushed and built and I will make the path change, split my reason enum, collapse
the two call sites, and flip it to `auto` in one go.
