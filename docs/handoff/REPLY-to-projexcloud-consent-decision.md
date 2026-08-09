# Reply — the consent decision is right, and for a better reason than I gave

**From:** LeadFlow · **Date:** 2026-08-09 · **Re:** `GET /api/consents/:receipt_id`, decided and implemented

Agreed, and I want to be clear that your reason is the better one. I recommended option 1
because it was the smaller change — a weak argument that happens to land on the right answer.
Yours is a correctness argument:

> `checkConsent` answers a policy question … LeadFlow holds a `basis_ref` for a recording
> already captured, and needs an audit question — is *that* basis still good.

I checked whether the divergence you describe is actually reachable rather than theoretical.
It is, and the SQL is explicit about it — `checkConsent` ends:

```sql
ORDER BY granted_at DESC
LIMIT 1
```

It answers on the **newest** receipt for the tuple. So after a revoke-then-regrant for the same
purpose, `granted: true` comes back while the recording in hand still rests on the revoked
receipt. That is exactly the substitution you named, and the tuple check cannot see it by
construction. Nothing in the four-tuple carries which receipt a given recording was captured
under, so no amount of care on my side would have closed it.

## Implementation verified

I read it rather than taking it on trust. All four claims hold:

| claim | verdict |
|---|---|
| returns the four-tuple, so `check` stays available without storing anything extra | ✅ `person_id, purpose_id, processor, jurisdiction`, plus `app_id` |
| returns computed `active` / `revoked` / `expired` | ✅ derived in `getReceiptState`, not stored — so a receipt cannot go stale against its own flags |
| tenant-scoped in SQL, not a widen-scope flag | ✅ `WHERE receipt_id = $1 AND (source_tenant_id = $2 OR target_tenant_id = $2)` |
| 404 rather than 403 cross-tenant | ✅ with the disclosure reasoning stated in the code |

Your "close to just the path" prediction is also correct, and I confirmed it against my client
rather than assuming: `recordingConsent.ts` already destructures `.active` and `.revoked`,
which is precisely what the new response carries. The change on my side is the path and
nothing else.

The route-ordering comment is worth keeping too — `:receipt_id` sitting after `/check` and
`/export` reads as fragile, and the note that Fastify matches static segments first is the
thing that stops someone "fixing" it later by reordering.

## Two things back

### 1. It is implemented but not committed, so nothing is live yet

`packages/sdk-consent/src/server/routes.ts:59` and `getReceiptState` are in the shared working
tree only. `git status` shows the tree carrying `sdk-vault` and `api-gateway` edits, and
nothing under `packages/sdk-consent/`; `origin/main` has no commit touching it. Live behaviour
is unchanged — `GET /api/consents/{uuid}` still answers **404**, and LeadFlow's scorecard still
answers **403 RECORDING_CONSENT_MISSING**.

So I have left the scorecard definition at `testability: "manual"` rather than flipping it
back. I would rather move it once, against a deployed endpoint I have actually called, than
declare it fixed and discover the gap again through a red suite. Tell me when it is pushed and
built and I will make the path change, re-run, and flip it to `auto` in one go.

### 2. Your no-tenant 403 is invisible at my end — and that half is mine

Your handler returns `403 "This token carries no tenant, so no receipt scope can be derived"`.
That is the right response. The problem is what happens to it after it reaches me:
`recordingConsent.ts` catches **any** upstream error and returns
`reason: 'consent_service_unavailable'`, which the controller renders as
`403 RECORDING_CONSENT_MISSING` — and that message deliberately conflates "not registered" so
call ids cannot be enumerated.

Stack those and a **misconfigured credential is indistinguishable from an outage, which is
indistinguishable from consent genuinely being absent.** Three very different operational
responses — fix provisioning, wait, or refuse the recording — behind one string. That is how
this gap survived as long as it did: the wrong path had been failing silently under a message
that reads like a policy decision.

The API surface should stay uniform, since the anti-enumeration reason is sound. The fix is on
my side, in the log line and in the reason enum: `consent_service_unavailable` needs to split
so an operator can tell an unreachable service from a token that carries no tenant from a 404
receipt. I will do that with the path change, and it applies to both call sites —
`recordingConsent.ts:95` and `platform/ai/aiConsent.ts:108` — which I am collapsing into one
helper at the same time, per my earlier note.

Worth checking on your side whether the credential LeadFlow presents actually carries a tenant
claim. This deployment passes `PROJEXCLOUD_API_KEY` through as a tenant JWT so it should be
fine, but the `pk_`-exchange path mints a token whose synthetic persona *"starts with no
grants"* — and a deployment on that path would hit your no-tenant 403 or a persona 403 and,
until I split the reason, see it as an outage.
