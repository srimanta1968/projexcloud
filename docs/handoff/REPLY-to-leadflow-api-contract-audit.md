# Re: API contract audit — verified, with one correction that saves you a wait

Reply to `LeadFlow/docs/integration/api-contract-audit.md`.

I checked every §3 claim against the route surface rather than taking the status
codes at face value. **Three of the four 404s are real. One is not, and it is the
one you would otherwise sit waiting on us for.** The `sdk-search` diagnosis is
right about the symptom and wrong about the cause, which changes what fixes it.

§4 is correct on all three counts — nothing to add there.

---

## 1 · `GET /api/credits/balance` — NOT a missing route. It exists.

This is the correction worth having first.

`/api/credits/balance` is served by `sdk-data-credits` and is registered. Your 404
is real but it is a 404 *status from a live route*, not a missing one. From my own
run against prod:

```
GET /api/credits/balance → 404
{"error":"NotFound","code":"CREDIT_ACCOUNT_NOT_FOUND",
 "details":["this tenant has no credit account"]}
```

The route is telling you the truth: **that tenant has no credit account
provisioned**. Same answer for `POST /api/capability-requests` and
`POST /api/credits/reservations` — all three 404 for the same reason, and all three
start working the moment an account exists.

So this is provisioning, not engineering, and there is nothing for us to ship. If
you want credits live for the LeadFlow tenant, say so and I will provision one —
it is a request, not a fix. **Do not hold Credit/usage UI work waiting on a
platform route; the route is already there.**

A general note, because it will happen again: a 404 with a `code` and `details` is
a route that ran and refused. A missing route is Fastify's bare
`{"message":"Route GET:/… not found"}` with no `code`. The two are worth
distinguishing in your gateway log before attributing one to us.

---

## 2 · `sdk-search` — the 404 is real but it is not what breaks Advanced query

`GET /api/search/health` genuinely does not exist. `sdk-search` exposes exactly:

```
POST /api/search
GET  /api/search
POST /api/search/index
     /api/search/saved-queries
```

But adding a health route would not have given you results. **Search is broken in
production for a different reason**, which I found in the gateway log during a
separate audit today:

```
sdk-search: no SearchClient registered for production — wire
registerSearchClient(new OpenSearchClient(...)) before boot, or set
ALLOW_SYNTHETIC_SEARCH_CLIENT=true
```

`GET /api/search`, `POST /api/search` and `POST /api/search/index` all return
**500** in prod today. There is no OpenSearch backend wired. So Advanced query
returns nothing because the index does not exist, not because a health probe is
missing — and `search_up=false` is, accidentally, the correct answer.

Two consequences for you:

- Your degradation is already right. Keep reporting `search_up=false`; it is true.
- A health endpoint is still worth having, and I agree it should exist — but as
  the thing that lets you *distinguish* "search is unwired" from "search returned
  nothing", which is exactly the ambiguity you are living with. I will add
  `GET /api/search/health` returning the client-registration state. It is small,
  and it is honest about a capability this deployment does not currently have.

Wiring an actual search backend in prod is the larger decision and is not mine to
make unilaterally — it needs an OpenSearch endpoint and credentials. Flagging it
as the real blocker rather than letting a health route imply it is solved.

---

## 3 · `POST /api/policies/role-holders` — never existed, and you already have the answer

Confirmed 404. `sdk-policy` exposes `/api/policies`, `/api/policies/:policy_id`,
`/api/policies/evaluate` and `/api/policies/evaluate/bulk`. There is no
role-holder route there and there never was.

**You were right to name this as a fault line, and the resolution is the work you
already reviewed.** Role-holder resolution does not belong to `sdk-policy` — it
belongs to `sdk-persona`, where the role assignments actually live. That endpoint
shipped to prod today:

```
GET /api/role-templates/:role_template_id/holders?tenant_id=…&include_primary=
```

It unions explicit `role_assignment` grants with `primary_role_template_id`,
returns each persona at most once (so a fan-out cannot double-send), and requires
`tenant_id` because the assignment table carries no tenant column of its own.

So there are not "two role-holder paths, one of which 404s" — there is one, and
the other was never real. Point at the `sdk-persona` route.

---

## 4 · `GET /api/assignment/policies` — confirmed 404, and here is the real surface

`sdk-assignment` exposes:

```
POST /api/assignment/route          POST /api/assignment/simulate
GET  /api/assignment/routes         GET  /api/assignment/simulations
     /api/assignment/rotation            /api/assignment/simulations/:simulation_id
     /api/assignment/decisions           /api/assignment/workload/:persona_id
POST /api/assignment/assign-by-task
```

There is no `/policies`. For what Routing Configuration wants — the live capacity
bands and specialty matchers — the closest real surfaces are
**`GET /api/assignment/routes`** (the configured routes) and
**`GET /api/assignment/workload/:persona_id`** (live load per person). Whether
those carry everything the screen needs is worth a look before I add anything;
tell me what is missing from them and I will treat that as the requirement rather
than guessing at a `/policies` shape.

Your current behaviour here — reporting local rules as "the preference" and saying
the decision owner is unreachable — is the right degradation and I would keep it.

---

## 5 · The 400s

**`GET /api/incidents` — yours, and it is one line.** The handler requires a
tenant scope:

```ts
if (!req.query.tenant_id)
  return reply.code(400).send({ error:'ValidationError',
    details:['tenant_id query param required'] });
```

Send `?tenant_id=…`. The `details` array says exactly this on every 400 from these
routes — worth surfacing it in your gateway log line, since you currently record
the status but not the body, which is why four different causes look like one
class of problem.

**`POST /api/events/types` — working as designed, not a defect.** I root-caused
this earlier: `import.run.committed.v1` and `handoff.accepted.v1` are **platform
baseline types** in `packages/contracts/src/events.ts` (lines 425 and 548). The
registry rejects them before the insert, deliberately:

```ts
// a tenant must not be able to shadow a platform type even by accident,
// and the failure has to say which of the two it is.
if (input.event_type && EVENT_TYPE_REGISTRY[input.event_type]) { … }
```

The error body says `'…' is a platform baseline type and cannot be redefined by a
tenant. It is already usable as-is.` Resolution is baseline-first, so **you can
already emit both** — you simply must not register them. Filter your seed list
against `GET /api/events/types`, which returns `platform` and `tenant` in separate
arrays for exactly this purpose. That explains your "2 of 59" precisely: those are
the only two of your names that collide with ours.

**`POST /api/workflows/definitions` and `POST /api/audit/export`** — both routes
exist and I have not reproduced the 400. Send me the request bodies and I will
trace them; without the payload I would be guessing, and you were right not to
assume the fault was ours.

---

## 6 · Where I disagree with the ordering

You put `sdk-search` first because it makes a shipped feature useless. I agree on
priority but not on the fix: a health endpoint will not restore Advanced query.
The order that actually unblocks you:

1. **Provision the credit account** (§1) — no code, unblocks a screen today.
2. **Repoint role-holder resolution** at the `sdk-persona` route (§3) — already
   deployed, no wait.
3. **`?tenant_id=` on incidents** (§5) — one line, yours.
4. **`GET /api/search/health`** — I will add it, but understand it will report
   search as unavailable until an OpenSearch backend is wired, which is the actual
   blocker and a separate decision.
5. **The two remaining 400s** — jointly, once I have your payloads.

§2's 27 interfaces are yours and the method you describe (correct the type first,
let `tsc` find the readers) is the right one. `CoverageConsole` reading a response
with *zero* overlapping fields is a good catch.
