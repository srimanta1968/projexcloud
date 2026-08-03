# QA fixture seeds on a deployed stack

Applies to the EC2 stack fronted by `cloud.projexlight.com` (the `staging` target
in `tests/config/test-config.json`), and to any other deployed environment you
point the API suite at.

## The problem this solves

A deployed stack starts with no fixture rows. The API suite's definitions
reference some fixed-id rows that **no endpoint can create** — an operator grant,
a platform-default taxonomy version, a dead-lettered webhook delivery that only
the retry worker mints. When those rows are absent the endpoint still exists and
is still reached; the handler just 404s on the lookup.

That failure is easy to misread as a missing route. It is not. Worked example:

```
GET /api/taxonomy/prompt-templates?name=invoice-extraction-v1 -> 404
```

`lookupPromptTemplate` (`packages/sdk-taxonomy/src/services/taxonomyService.ts`)
joins `taxonomy.prompt_template -> taxonomy.version` with `v.status='active'`.
With no active version row the join matches nothing and `routes.ts` returns 404 —
from a route that is correctly registered and serving traffic.

## Why it wasn't happening automatically

`tests/setup_scripts/` holds two kinds of setup, and only one of them ever ran:

| Kind | Runs? | Where |
|---|---|---|
| `*.py` / `*.js` | yes, every API run | `api_test_runner.py:_run_setup_scripts` |
| `*.sql` | **no** | explicitly skipped — "`*.sql` is ignored — those are handled elsewhere" (`api_test_runner.py:1283`) |

"Handled elsewhere" had no elsewhere for a deployed target. The `.py` scripts work
anywhere because they only need the SUT's HTTP surface; the `.sql` ones need
database access, which the Test MCP does not have against a remote host.

## Applying them

Run **on the deploy host, from the repo root**. The host has the full checkout
(the gateway *image* does not — its Dockerfile COPYs `packages/ services/ native/
tools/ scripts/`, not `tests/`), which is why this is a host-side script.

```bash
cd /home/ec2-user/projexcloud
scripts/setup/apply-qa-seeds.sh --dry-run     # list what would apply
scripts/setup/apply-qa-seeds.sh --yes         # apply
scripts/setup/apply-qa-seeds.sh --yes --only taxonomy_seed_prompt_template.sql
```

Every seed is written `INSERT ... WHERE NOT EXISTS` or `ON CONFLICT DO UPDATE`, so
re-running is a no-op. Safe on every deploy.

It reads `POSTGRES_USER` / `POSTGRES_DB` from the running container rather than
requiring `.env.prod` to be sourced, and applies each file in its own `psql`
invocation with `ON_ERROR_STOP=1` so one bad seed reports instead of silently
half-applying.

Overrides: `PG_CONTAINER` (default `projexcloud_pg`), `PG_USER`, `PG_DB`.

## Deliberately NOT applied: per-def fixtures

Two seeds carry a `{{cache:...}}` placeholder:

- `data_credits_account.sql`
- `seed_webhook_dlq.sql`

These are **not** deploy-time fixtures. They are attached to individual
definitions via `"setupScript"` + `"testability": "semi-auto"` and are meant to
run per-def at test time, after the producer they reference
(`auth.signup-tenant`) has resolved. Applying them at deploy time is not merely
wrong, it is impossible — the literal `{{cache:...}}` fails the `uuid` cast.

The script skips them and says so. Do not "fix" that by substituting a tenant id.

> **Known gap.** The Test MCP carries `setupScript` through its data model
> (`api_library_client.py:1693`, `server.py:143`) but **never executes it** — there
> is no code path that runs a per-def setup script. So these two fixtures do not
> currently run anywhere, and the tests depending on them (data-credits balance,
> webhook DLQ replay) fail for that reason. Closing this needs a change in
> `projex_test_mcp`, not in this repo.

## Should this be wired into deploy?

Not by default. These seeds create fixed-id QA rows — correct for a staging/QA
database, wrong for a customer-facing production one. The script therefore
refuses to run without `--yes` and has no default-on path.

If you want it automatic for a QA environment, call it from `deploy-service.sh`
behind an explicit env flag (e.g. `APPLY_QA_SEEDS=1`) rather than making it
unconditional.

## Verifying

```bash
scripts/setup/apply-qa-seeds.sh --yes
mcp-server/run-all-tests.sh api --env staging
```

Measured effect of applying the 7 deploy-time seeds on 2026-08-03:

| | before | after |
|---|---|---|
| pass rate | 85.1% | **87.2%** |
| failed | 105 | 88 |
| 404s | 40 | 26 |

`GET /api/taxonomy/prompt-templates?name=invoice-extraction-v1` went 404 → 200.
