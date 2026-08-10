# Bulk checks for the Channel Decision engine — one ask, with the arithmetic

**From:** LeadFlow · **Date:** 2026-08-10 · **Re:** TK-3963, and an acceptance criterion I cannot meet

You offered to work this as co-developer. Here is the one thing I need, why I am
confident it is yours rather than mine, and what I am doing on my side meanwhile.

---

## The ask

**A bulk variant of the four checks the Channel Decision composer calls**, so one
request covers N subjects instead of N requests covering one each:

| today (per subject) | needed |
|---|---|
| `POST /api/consents/check` | accept an array of tuples, return an array of verdicts |
| `POST /api/policies/evaluate` | same |
| `POST /api/deliverability/check` | same |
| `POST /api/notifications/send-window` | same |

I checked all four packages: there is no `/bulk` or `/batch` route on any of them.

Shape does not matter much to me — an array in, an array out, order-preserving, with
a per-item verdict rather than one aggregate. Partial failure should be per-item too:
one unresolvable subject should not fail the batch, because a campaign check that
fails whole is a campaign that silently does not go out.

---

## Why this is not a micro-optimisation

TK-3963's third acceptance criterion reads:

> Bulk evaluation scales to a 100k audience within the request budget.

The composer makes **four upstream calls per subject**, deliberately **sequential** —
the existing comment says why, and I agree with it:

> a bulk decision for a thousand recipients fired at once is a thousand simultaneous
> calls to four SDKs, which trips their rate limits and then the circuit breaker —
> turning a routine campaign check into an outage for every other feature sharing
> those SDKs.

So a 100k audience is **400,000 sequential upstream calls**. At an optimistic 10ms
each that is **~67 minutes**. The criterion is not merely hard to meet inside a
request budget; it is wrong by two orders of magnitude, and no amount of tuning on my
side closes that. Parallelising is the one thing the design already rejects for good
reason, and it would convert my problem into an outage for every other consumer of
those four SDKs.

With bulk endpoints the same audience is **4 calls**, or a small number of paged
ones. That is a request-budget operation.

---

## What I will do regardless of your answer

So this is not blocked on you:

1. **The architecture test (AC1)** — "no LeadFlow send path reaches a provider
   without a recorded `decisionRef`". There is already a precedent I can follow:
   `sdkGatewayBoundary.test.ts` fails the build if any module opens an HTTP
   connection to ProjexCloud outside the gateway. Same shape, different invariant.
   Mine, and I am writing it.
2. **AC2 (reasons ordered, no internal codes leaked)** — mine to verify and fix.
3. **AC4 (re-evaluated at execution, never cached past validity)** — mine.
4. **AC3** — I will report `partial` with this arithmetic, rather than claiming a
   budget I cannot hit or quietly narrowing "bulk" to a size that happens to pass.

If bulk endpoints are a larger piece of work than they look, say so and I will make
the bulk path **asynchronous** on my side instead — a job handle plus polling, which
is honest about what a 100k evaluation actually is. That is a worse API for the
caller, so I would rather not, but it is a real fallback and it is mine to build.

---

## One thing that would help beyond this task

The absent `GET` for registered purposes has now blocked criteria on **three**
separate tasks:

- the Consent screen's purpose taxonomy panel (renders a gap instead of a list);
- the Capture Consent modal's signature-encryption path, which cannot be exercised
  end to end because issuing a real receipt needs a valid registered `purpose_id` and
  there is no way to discover one;
- and this engine, whose `purpose` fieldEnum I am populating from a mockup rather
  than from the registry.

`POST /api/consents/purposes` registers one; nothing lists them. A `GET
/api/consents/purposes` returning the registered taxonomy would close all three. It
is the highest-leverage small thing outstanding between us — smaller than the bulk
work above, and it unblocks more.

---

## Not asks, just so you have them

- `/api/empi/metrics` reports `unresolved_candidate_links` (open only) alongside
  `confidence_distribution` (all statuses), so a caller can see `total: 1` with
  `high_risk: 2`. Both are correct; they count different populations. I am fixing my
  rendering rather than asking you to change the numbers, but you may want the same
  caveat in the manifest.
- Your tenant scoping is visible end-to-end from here: `retracted_links` went 253 → 0
  and `false_link_rate` 0.5435 → 0 through my endpoints, which is the platform-wide
  aggregate disappearing exactly as intended.
