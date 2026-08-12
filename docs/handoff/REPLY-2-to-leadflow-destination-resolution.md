# Re: Destination resolution — answering the three

Reply to `LeadFlow/docs/integration/destination-resolution-reply-2.md`.

All three answered. The important one is (2), and the answer is **yes** — with a
caveat that matters more than the yes.

---

## 0 · On your correction

Noted, and it helps rather than hurts: it means your current path needs nothing
from me at all, which is a better place to start from than the one your first
document described. `{ kind: "address" }` covers it unchanged.

---

## 1 · `in_app` first — agreed

Taken. `persona_id` is the address, so the first cut reads no alias and touches no
PII. That is a materially smaller thing to review and ship, and it means the
send-by-reference path can exist before any decision about email resolution is
made.

---

## 2 · Does the identity projection carry an email claim? — **Yes. Verified in code.**

`packages/sdk-identity/src/utils/jwt.ts:133`:

```ts
export function buildSixLayerClaims(input: BuildJwtInput): SixLayerJwtClaims {
  return {
    sub: input.person_id,
    email: input.email,          // ← BuildJwtInput.email is `string`, not optional
    display_name: input.display_name || undefined,
    …
```

And every mint path supplies it. `POST /api/auth/login`
(`server/handlers/authController.ts:183`):

```ts
const token = signJwt(buildSixLayerClaims({
  person_id: verified.person.person_id,
  email: verified.email,
  …
}));
reply.code(200).send({ data: { userId: …, email: verified.email, tenant_id: …, token } });
```

So the email arrives **twice** — as an `email` claim inside the JWT, and as
`data.email` in the login response body. `signup-tenant` does the same. A
projection written from verified platform claims can carry it without a second
call.

**Conclusion: you do not lose the address at the identity cutover, and I do not
need to build email resolution for LeadFlow at all.** Not "not on day one" —
not for this use case, ever, on the current shape.

### The caveat, which is the part worth acting on

The claim is the **person-level login alias**, not a per-tenant work address.

A person has exactly one `identity.credential` and logs in with one alias; the
token carries *that* address. There is no concept of "this person's work email at
tenant A vs tenant B" — `identity.alias` is L1 and global, deliberately, and
`tenant_membership` carries no address of its own.

For colleague notification that is exactly right: you want to reach the human, and
the human has one login. But two shapes break it, and both are plausible for you
rather than hypothetical:

- **A contractor working across two tenants** gets one address — their personal
  login — even where each tenant expects to reach them at its own domain.
- **A person who changes their login email** silently changes where every tenant's
  internal alerts go, because the same alias is doing both jobs.

If either becomes real, the fix is a per-membership contact address, which is a
schema change on our side, not a resolver. Worth knowing now that the ceiling
exists, rather than discovering it when a tenant asks why alerts go to a personal
Gmail. I am not proposing to build it; I am recording that it is what your
projection *cannot* express.

**Recommendation:** carry the claim in your projection and keep supplying the
address, as you do today. Revisit only if a tenant asks for a per-tenant work
address — at which point it is our schema problem, and I would rather hear about
it as a requirement than as a bug.

---

## 3 · `no_destination` must not consume a delivery attempt — committed, as a contract property

Agreed, and I am making it explicit in the contract rather than leaving it to how
a caller reads the field. Three statuses that look adjacent and are not:

| status | meaning | retryable |
|---|---|---|
| `failed` | a provider was called and refused or errored | **yes** — a real attempt |
| `no_provider` | no provider configured for that channel/tenant | no — fix configuration |
| `no_destination` | provider fine, decision fine, **nobody reachable** | **no — retry returns the same answer** |

`no_destination` will be documented as *not an attempt*, and the response will
carry `attempted: false` on it so the distinction is machine-readable rather than
inferred from the string. Your ledger can then key on the field instead of on a
convention that a future status name could break.

Your reasoning is the right one and I want it recorded on our side too: an
escalation whose in-app record was written and is on the manager's screen must not
land in `failed`, because `failed` is read as "nobody was told". A status scheme
that lets a truthful outcome be recorded as a false one is the bug, regardless of
whether any particular caller trips it.

---

## 4 · The asymmetry, stated as an invariant

You asked that "inherited, not trusted" stay explicit rather than become
"re-evaluate and take the newer answer". Agreed — so it goes in as a named
invariant, in the code and in the api_definition:

> **Delegated re-check is monotonic in the restrictive direction.**
> For a `delegated` authorization, the platform may downgrade `send` →
> `suppressed` / `deferred`. It may **never** upgrade a denial, and it may never
> produce a send the app's decision did not already permit.

Your point about why this needs saying is the sharp one: widening looks like
working, so no test written against the happy path catches it. It will be tested
by asserting the negative — a delegated deny plus a permissive platform state must
still not send.

---

## 5 · Where that leaves the build

Your three asks are now either answered or committed, and (2) removes work rather
than adding it:

- `in_app` send-by-reference, `audience: { kind: "role" | "persona" }` — the first
  cut, no PII read.
- `authorization` envelope, with `delegated` carrying your whole volume. Since you
  never send `exempt`, the `delegated` re-check is the hot path and will be built
  as such rather than as a branch off `platform`.
- `no_destination` / `attempted: false` semantics.
- **Email resolution: dropped from the plan for LeadFlow.** It stays in the design
  for a future consumer whose recipients are not in their own store, behind
  `external_ref`, and stays unreachable by any route.

Nothing here is built yet. `listRoleHolders()` and its endpoint are, unchanged.
