# Setup scripts — what belongs here, and what does not

The dev MCP runs every `*.sql` in this directory before a suite, and per-definition scripts
via `setupScript`. **None of it runs on a deployed stack.** That is correct for a test
fixture and wrong for product data, and the two have been mixed.

## Why the distinction matters

If an endpoint only passes because a file here created a row, then on a real install that
endpoint fails — and the failure is invisible locally, because locally the row always
exists. Measured on 2026-08-06: `POST /api/media/upload-url` returned `400 VaultKeyMissing`
in production, and because six media and evidence endpoints depend on the blob id it
produces, they were all reported as *skipped* rather than failed. One missing row silently
removed seven endpoints from the result, and a missing
`EVIDENCE_LEGAL_EXPORT_SIGNING_KEY` hid behind that cascade entirely.

So: before adding a file here, ask whether a paying customer's fresh install needs the row.
If yes it is not a fixture, and it belongs in the product.

---

## Product reference data — should NOT be here

These create rows a real tenant genuinely needs. They are in this directory because nothing
in the product creates them, which is a gap, not a test requirement. Tracked on **TK-4156**.

### `media_seed_tenant_vault_key.sql` — the clearest case

Its own header says it: *"signup-tenant does NOT provision this key."*

`resolveVaultKeyRef()` requires `vault.key WHERE tier='tenant' AND scope_id=<tenant> AND
state='active'`. Every tenant that stores media needs one, and tenant creation does not
issue it. In production this is a real `400 VaultKeyMissing` for every tenant ever created.

**Correct fix:** issue a tenant-tier key as part of tenant creation. Note this needs a
decision first — `sdk-identity` has no `sdk-vault` dependency today, so provisioning inside
`signup-tenant` adds an edge between two foundation SDKs. The alternative is a tenant
lifecycle hook that vault subscribes to, which keeps identity unaware of vault. **Do not add
the dependency without making that call deliberately.**

### `taxonomy_seed_prompt_template.sql`

Seeds a *platform-default* (`tenant_id IS NULL`) active taxonomy version and prompt
template. A platform default is product reference data by definition — every install needs
the same row, and it does not vary per tenant. This belongs in an `sdk-taxonomy` migration.

### `data_credits_catalog.sql` — split it

The capability *catalog* is product reference data. The specific QA capability key
(`validate.phone-smoke`, referenced from `test-config.json`) is a fixture. Ship the catalog
as a migration; keep the smoke key here.

---

## Genuine test fixtures — correctly here

These create preconditions that exist to make a test *repeatable*, not because a customer
needs them. They must stay out of a deployed stack, and definitions asserting them should
not be run against one.

| File | Why it is a fixture |
|---|---|
| `seed_webhook_dlq.sql` | Resets two `webhook.delivery` rows to `dlq` before each replay test so the test passes on every run, not just the first. A production DLQ is populated by real delivery failures — pre-seeding one would be fabricating an incident. |
| `federation_seed_federation.sql` | Seeds the parent `federation` row that `failover_event` references. Federation topology is an operator decision in production, deliberately configured, never auto-created. |
| `federation_seed_route.sql` | Seeds a sanctioned cross-pool route so the lookup resolves instead of 404. Same reasoning — routes are sanctioned deliberately. |
| `00_seed_fixtures.sql` | Reference rows the tests address *by fixed id*. A fixed id is the tell: product data does not need a predetermined uuid, only a test does. |
| `assignment_seed_workload_pool.py` | QA workload pool. |
| `provision_lead_scoring_retire_fixture.py` | QA retire-path fixture. |
| `provision_media_and_ontology.py` | QA media + ontology provisioning. |

---

## The rule

> A row keyed to a **fixed uuid** or to `{{cache:…}}` from the current run is a fixture.
> A row every install needs, with an id the product generates, is product data — and it
> belongs in a migration or a lifecycle hook, not in this directory.

When adding a file, state which it is and why in the header comment, as the existing files
do. If it is product data, open a task instead of adding the file.
