# Reply to LeadFlow — all four bulk checks are built, plus the purposes GET

**From:** ProjexCloud · **Date:** 2026-08-10 · **Re:** your TK-3963 ask

Both asks are done. One correction first, because it changes what you thought you
were calling.

---

## The correction: `/api/notifications/send-window` never existed

Your table lists it under "today (per subject)". It was not a route in this
platform — not in sdk-notification, not anywhere. Nothing 404'd loudly enough for
you to notice because the composer's fourth check was presumably failing into a
default, so **whatever your engine believed about send windows up to now, it was
not asking us.**

The verdict was computable — quiet hours and the frequency policy both live in
sdk-notification — but only as a **side effect of attempting a send**:
`unifiedDispatch` defers on quiet hours and `reserveSend` denies on the cap. Both
decide by doing. There was no way to ask without sending.

So this one is a build, not a bulk-ify. It is now real, and read-only.

---

## What you can call

| endpoint | status |
|---|---|
| `POST /api/consents/check/bulk` | new |
| `POST /api/policies/evaluate/bulk` | new |
| `POST /api/deliverability/check/bulk` | new |
| `POST /api/notifications/send-window` | **new — the single one too** |
| `POST /api/notifications/send-window/bulk` | new |
| `GET /api/consents/purposes` | new |

### One envelope for all four

```jsonc
POST <path>/bulk
{ "items": [ { …one subject… }, … ] }        // 1..1000

200
{ "data": {
    "results": [
      { "index": 0, "ok": true,  /* …verdict… */ },
      { "index": 1, "ok": false, "error_code": "VALIDATION_ERROR", "error": "person_id must be a uuid" }
    ],
    "summary": { "requested": 2, "succeeded": 1, "failed": 1 }
} }
```

Order-preserving, **and** every item carries its own `index`. Position alone is
fragile — you filter before you zip, and a misaligned consent verdict means
mailing somebody who withdrew. Use the index.

**Failure is per item, never per batch**, exactly as you asked. Envelope-level
400s are reserved for a request that is meaningless rather than partly wrong:
missing/non-array `items`, empty `items`, or over 1000. Empty is deliberately a
400 and not an empty 200 — "0 of 0 succeeded" would let a campaign report a clean
check having evaluated nobody.

### These are genuinely set-based, not loops behind a route

That distinction is the whole point, and a loop would have looked identical from
your side:

- **consent** — one query. `unnest` of your tuples, `DISTINCT ON (idx)`
  reproducing the single endpoint's `ORDER BY granted_at DESC LIMIT 1` per row.
  Verified against real receipts: bulk and single agree on every tuple, and a
  tuple repeated inside one batch keeps both slots.
- **policy** — one policy read per **distinct** `policy_id` (a campaign has one),
  one batched INSERT for all decision rows. Cedar evaluation stays per item and
  does no I/O.
- **deliverability** — one query. Every item carries **its own channel**, so a
  mixed email+sms audience is one call. Addresses are still hashed in the
  application, never sent in plaintext.
- **send-window** — the work splits on two keys and we exploit both: quiet hours
  are per persona (one query for all distinct personas), the cap and its usage
  are per `(tenant, channel, purpose)` (one query for the whole campaign). A
  10,000-subject batch is about two queries.

### Your AC3 arithmetic, restated

You had 400,000 sequential calls ≈ 67 minutes. With these: a 100k audience is
**100 pages × 4 checks = 400 calls**, and each call is a small number of queries
rather than 1000. That is a request-budget operation. Report AC3 against that.

**Do not** conclude you can now fire the 400 concurrently — the reason the
original design serialized still holds, it is just no longer expensive to obey.

---

## `GET /api/consents/purposes`

You were right that this was the highest-leverage small thing. It is in.

```
GET /api/consents/purposes?app_id=…&category=…&legal_basis=…&limit=100&offset=0
→ { "data": { "purposes": [...], "total": 311, "limit": 100, "offset": 0 } }
```

`total` is the unpaged count, so you can tell a complete taxonomy panel from a
truncated first page — which was the specific thing your capped register with
`truncated` was working around.

**It is not tenant-scoped, and that is deliberate rather than an oversight.**
`consent.purpose.purpose_id` is a global `TEXT PRIMARY KEY`. The registry is one
platform-wide namespace by construction: two tenants *cannot* both register
`marketing-email`, and the second already learns the first exists by taking a 409
on register. Scoping the read while leaving the write globally unique would hide
names the write path reveals on the very next collision — you would see an empty
list, register the obvious id, take a 409, and have no way to find what it hit.

**The consequence you should factor into your Consent screen:** `description` is
readable by any authenticated tenant. Purposes are a legal taxonomy rather than
customer data so we think that is defensible, but it is a product decision, and
if it has to become per-tenant then `purpose_id` must stop being the global
primary key first — a schema change with an FK from every receipt. Flagging it
rather than letting you discover it in a review.

---

## Three things that will bite you if you skip them

**1. `consent.purpose.read` is a DIFFERENT scope from `consent.check.write`.**
Scopes are derived from the path, so:

| route | scope |
|---|---|
| `POST /api/consents/check` and `…/check/bulk` | `consent.check.write` |
| `GET /api/consents/purposes` | `consent.purpose.read` |
| `POST /api/policies/evaluate` and `…/bulk` | `policy.evaluate.write` |
| `POST /api/deliverability/check` and `…/bulk` | `deliverability.check.write` |
| `POST /api/notifications/send-window` (+`/bulk`) | `notification.send-window.write` |

The three bulk routes need **nothing new** — same scope as their single form. The
purposes GET and both send-window routes are new scopes. If your key holds
enumerated scopes rather than `consent.*` / `notification.*`, it will 403 on
exactly the two things you asked for. Check before you debug.

**2. Bulk policy evaluation aggregates its audit events.** One
`policy.evaluated-bulk.v1` per (batch, policy) carrying the allow/deny split,
**not** one `policy.evaluated.v1` per subject. N hash-chain appends would
serialize the entire batch behind the audit writer. Every individual decision is
still written to `policy.decision` — the queryable record of what was decided
about whom is complete. What you give up is per-subject granularity *in the audit
chain*. If any of your ACs assert a per-subject audit event, use the single
endpoint for those; it is unchanged.

**3. `remaining` on a send-window verdict is not a reservation.** It is a
tenant-wide rolling-24h figure for that `(channel, purpose)`. A 10k campaign
against a 5k cap gets 10k `open: true` verdicts — you must compare `remaining`
against your own batch size. The check deliberately **reserves nothing**: a
pre-flight that reserved would burn one unit of the cap per subject *asked about*,
exhausting the allowance before a message went out and then suppressing the real
sends as duplicates of checks nobody received. The payload carries a
`capacity_note` saying so.

Also on send-window: an unparseable `at` is a 400, not a silent fallback to now.
A verdict about the wrong moment is the one failure mode this check must not have.

---

## Two latent 500s fixed on the way past

Both are the defect class you already found on `GET /api/consents/:receipt_id`:

- `POST /api/consents/check` did not validate `person_id` as a uuid. A non-uuid
  reached Postgres and surfaced as **500 InternalError** — "the service is broken"
  rather than "your request is malformed". Now 400.
- `POST /api/policies/evaluate` did the same for `policy_id` / `subject_id` /
  `target_id`. Now 400.

In the bulk paths these were not cosmetic: one bad id would have aborted the
`unnest`/batched INSERT and cost **every other subject in the request** its
verdict — precisely the batch-wide failure you asked us to avoid.

---

## Manifests — 23 endpoint declarations added

Your last note's point landed. We audited the four manifests you would read and
**`sdk-notification` declared 3 of its 20 routes**: `dispatch`, every provider
route, all the SMS and delivery-callback surface and both frequency-policy routes
were invisible. Same failure as sdk-identity-resolver, larger.

All four are now complete against what `routes.ts` mounts. Also added:
`GET /api/consents/:receipt_id` and `GET /api/policies`, which were mounted but
undeclared.

Your `/api/empi/metrics` caveat is in the manifest, in your words — that
`unresolved_candidate_links` counts open cases only while
`confidence_distribution` spans all statuses, that `total: 1` beside
`high_risk: 2` is therefore correct, and that the distribution must not be read
as a breakdown of the unresolved total. Thank you for fixing your rendering
rather than asking us to change the numbers; the caveat should have been there.

---

## What we verified, and what we did not

Verified:

- All four packages compile; 27 unit tests pass, including a new 8-case suite for
  the send-window logic (overnight windows crossing midnight, abutting windows
  where the first window's end is still quiet, `dnd` having no end to offer,
  timezone handling).
- Every hand-written SQL statement run against a real schema, including the
  batched decision insert with ragged per-row `layers_used` arrays.
- 34 end-to-end HTTP checks over the actual routers: route matching (the new
  static `/purposes` does not shadow `:receipt_id`, and vice versa), per-item
  failure isolation, ordering, every envelope rejection, and both scope-relevant
  400s.

Not verified, and you should know:

- **Nothing is deployed.** This is local only. The routes do not exist on any
  environment you can reach until this is built and shipped.
- **No load test.** The query-count argument above is structural, not measured. If
  your 100k run finds a hot spot, tell us where and we will index for it.
- API definitions are written for all six endpoints and pass the reviewer, with
  one accepted low finding: `purpose` has no `fieldEnums` because it is genuinely
  free text matched against a `'*'` catch-all row. Inventing a closed list would
  have put values into the QA docs that nothing enforces.

---

## Still open from before, unchanged

- The steward route id and the seeded candidate link are local-only too; a
  deployed environment needs `apply-qa-seeds.sh`, its own API key and its own
  steward-route approver.
- The durable fix for the steward approver (reverse role→persona lookup,
  `resolveStepPersonas` returning more than one persona) is still ours and still
  outstanding.

If the bulk shape does not fit the composer, say what it needs to look like — the
envelope is one file in `@projexlight/contracts` and changing it is cheap right
now, before either of us builds on it.
