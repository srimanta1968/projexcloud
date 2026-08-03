# SDK Consumption Contract

**Status:** active · **Scope:** every `@projexlight/*` package a vertical application installs · **Gate:** `node scripts/ci/neutrality-gate.js`

ProjexCloud is one horizontal platform consumed by many verticals. The same `sdk-sla` serves
a healthcare tenant, a field-service tenant and a logistics tenant. This document states
what that costs each side: what an SDK guarantees, and what an application may and may not
do to it.

The rule underneath all of it: **an SDK owns a mechanism; an application owns its meaning.**

---

## 1. Table ownership

An SDK owns its schema. No application writes to another package's tables.

| SDK | Owns schema | Principal tables |
|---|---|---|
| `sdk-conversation` | `conversation` | `thread`, `message`, `session`, `turn`, `handoff` |
| `sdk-parsing` | `parsing` | `job`, `stage_result`, `extracted_field`, `review_task` |
| `sdk-projection` | `projection` | `subject_view`, `attribute_assertion`, `survivorship_rule`, `replay_snapshot` |
| `sdk-notification` | `notification` | `quiet_hours`, `frequency_policy`, `send_ledger`, `delivery_receipt` |
| `sdk-rebac` | `rebac` | `relationship`, `relationship_decision` |
| `sdk-connectors` | `connectors` | `install`, `sync_cursor`, `lead_form_event`, `sync_deadletter` |
| `sdk-lead-scoring` | `lead_scoring` | `model`, `feature_weight`, `score` |
| `sdk-audit` | `audit` | `entry`, `chain_head` |

**Why ownership is absolute.** These tables carry triggers, CHECK constraints and rollup
columns that enforce the SDK's invariants — `conversation.message` alone has four
constraints making an undispatchable internal note unrepresentable. An application writing
directly bypasses the service layer but *not* the constraints, so it fails in a confusing
way; where it does succeed, it silently breaks an invariant a reader downstream depends on.

**Read access** is permitted. **Write access** is through the SDK's service or HTTP surface,
always.

---

## 2. Domain events

Events are the supported way to react to something an SDK did. Every one is registered in
`packages/contracts/src/events.ts`; emitting an unregistered type throws.

| SDK | Events |
|---|---|
| `sdk-conversation` | `conversation.thread.opened.v1`, `conversation.thread.closed.v1`, `conversation.reply.linked.v1`, `conversation.reply.unmatched.v1`, `conversation.session.*` |
| `sdk-projection` | `projection.replay.completed.v1`, `projection.assertion.retracted.v1` |
| `sdk-lead-scoring` | `lead-scoring.scored.v1` |
| `sdk-parsing` | `parsing.job.completed.v1` |

Two properties worth knowing before you depend on one:

- **Emission is best-effort.** `emitEvent` catches and logs rather than propagating, so an
  audit outage never blocks the caller's hot path. A successful API response is therefore
  *not* proof the event was appended — assert against `audit.entry` if you need certainty.
- **`v1` is a contract.** Fields are added, never removed or retyped. A breaking change
  ships as `v2` alongside.

---

## 3. What an application MAY extend locally

- **Its own tables**, in its own schema, referencing SDK rows by id.
- **Resolvers and backends.** Most decision points are injectable precisely so a vertical
  supplies its own judgement: `setContactLlmAdjunct`, `setSchemaResolver`,
  `setPreSendGuard`, `setNextBestActionResolver`, `registerB2BFeature`,
  `setContactBackend`.
- **Tenant configuration** — survivorship rules, frequency policies, extraction schemas via
  `sdk-taxonomy`, scoring weights. All are tenant-first with a platform default.
- **Consent, policy and eligibility.** The platform records what you decided and when; it
  never decides for you.

## 4. What an application MAY NOT do

- Write to another SDK's tables, or add columns to them.
- Fork a package to add a vertical concept. If the concept does not fit, the SDK needs a
  new injection point — raise it rather than forking, because a fork stops receiving fixes
  the same day it is made.
- Depend on an unregistered event type, or on field order in a JSONB column.
- Put vertical vocabulary into an SDK. See the gate below.

---

## 5. The neutrality gate

`scripts/ci/neutrality-gate.js` fails the build if a vertical noun, stage name, role name
or hardcoded business rule appears in the **source** of a platform package, naming the
offending `file:line`.

**Why it is mechanical.** A domain word in a variable name reads as helpful specificity in
review, not as coupling — it is close to invisible until the second vertical arrives and
forks the package. Machines are better than reviewers at noticing it every time.

**What it does not flag**, deliberately:

- **Comments.** A comment saying "holds no patient-specific logic" is the author
  documenting neutrality. Flagging it would teach people to delete the explanation rather
  than the coupling.
- **Tests.** Fixtures need concrete data to be readable.
- **`apps/**`.** A vertical application is *supposed* to know its own domain.

**Precedent.** The gate found real coupling on its first run: `sdk-parsing` had
`patient_name`, `medication` and `prescription` hardcoded as classifier and extractor
defaults. Rather than allowlist them, the vocabulary moved to
`document-vocabulary.json` — data a tenant replaces, leaving the TypeScript holding only
the mechanism. Behaviour was unchanged and all 40 tests stayed green. That is the shape of
the correct fix: **push the domain out to configuration, do not suppress the warning.**

Run locally before pushing:

```bash
node scripts/ci/neutrality-gate.js
NEUTRALITY_SCOPE=sdk-conversation,sdk-parsing node scripts/ci/neutrality-gate.js
```

---

## 6. Versioning

Packages publish to the private registry with semver and a changeset per release. Additive
surface is a minor; a removed or retyped field is a major. `publishConfig.registry` is
deliberately absent from every package so `.npmrc` decides dev vs production — see
`scripts/release/set-registry.js`.
