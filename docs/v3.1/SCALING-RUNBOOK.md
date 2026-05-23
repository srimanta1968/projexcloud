# Horizontal Scaling & Performance Runbook

How to scale ProjexCloud past one Postgres + one Node process.

## Architecture invariants (already true)

- Every per-tenant table carries `tenant_id`.
- `routing.tenant_pool_map` maps each tenant to `admin_pool_index`,
  `evidence_pool_index`, and a JSON of `app_id → pool_index`.
- `routing.pool` is the registry: each `pool_index` has `primary_endpoint`,
  `replica_endpoints[]`, `region`, `status`, capacity tracking.
- Workers (transcode, webhook delivery, SLA timer, dunning, audit
  verifier, retention shredder) use either `FOR UPDATE SKIP LOCKED`
  pulls or `pg_try_advisory_xact_lock` leader election — multi-pod safe.

## Runtime changes shipped

### 1. Multi-pool `db-runtime`

`packages/db-runtime/src/index.ts` is now multi-pool aware:

```ts
import { registerPool, dataService, resolvePoolForTenant } from '@projexlight/db-runtime';

// Register at boot
registerPool('admin-0', { host: 'pg-admin-0', port: 5432, ... });
registerPool('app-0',   { host: 'pg-app-0',   replicas: [{ host: 'pg-app-0-replica-a' }, ...] });
registerPool('app-1',   { host: 'pg-app-1',   ... });

// Per-request — write to primary of resolved pool
const pool = await resolvePoolForTenant(tenantId, 'app:billing');
await dataService.rowsOn(pool, 'INSERT INTO billing.invoice ...', [...]);

// Per-request — read from a replica (lag-tolerant)
await dataService.readRowsOn(pool, 'SELECT * FROM billing.invoice WHERE ...', [...]);
```

The legacy single-pool API (`dataService.rows`, `getPool()`) still works
and resolves to `'default'`. Existing SDK code keeps running unchanged
during incremental adoption.

### 2. Per-connection perf defaults

Every pool now ships with:

| Setting | Default | Env override | Why |
|---|---|---|---|
| `max` connections | 20 | `DB_POOL_MAX` | PgBouncer in front, transaction-pooling |
| `min` connections | 2 | `DB_POOL_MIN` | Avoid cold-start latency |
| `idleTimeoutMillis` | 30000 | `DB_POOL_IDLE_MS` | Release idle conns to PgBouncer |
| `connectionTimeoutMillis` | 5000 | `DB_POOL_CONNECT_MS` | Fail fast on a dead Postgres |
| `keepAlive` | true | — | PgBouncer doesn't churn TCP |
| `statement_timeout` | 30s | `DB_STATEMENT_TIMEOUT_MS` | One slow query never holds forever |
| `idle_in_transaction_session_timeout` | 10s | `DB_IDLE_TXN_TIMEOUT_MS` | Abandoned txns auto-killed |
| `application_name` | `projexlight-<svc>-<pid>` | — | Visible in `pg_stat_activity` |

### 3. Redis-backed soft-cap counter

The gate previously ran `SUM(units) FROM meter.usage_event WHERE …` on
every metered request — O(rows-this-month) per gate check. Now:

- `installRedisUsageCounter()` registers a per-(tenant, sku, period) Redis
  counter (key: `usage:YYYY-MM:tenant:sku`, TTL ~32d).
- `meterGate.report()` does an `INCRBYFLOAT + EXPIRE` pipeline after every
  emit — best-effort, never blocks the request.
- `meterGate.check()` does a single `GET` on the gate path.

Hot-path complexity dropped from O(month-of-rows) Postgres scan → O(1)
Redis GET. Postgres remains the durable source of truth via
`meter.usage_event`; counter divergence is detectable by the existing
audit chain verifier and correctable by replaying from the table.

## Cross-schema JOIN audit findings

Run `node scripts/audit-cross-schema-joins.mjs` (output snapshot:
`docs/v3.1/CROSS-SCHEMA-AUDIT.txt`). Current state: **10 hard FK + 38
JOIN/FROM references** across 12 SDKs that block per-SDK Postgres splits.

### High-priority fixes (do these BEFORE splitting)

| SDK | Cross-schema dep | Fix |
|---|---|---|
| **sdk-billing** | `meter.pricing_catalog`, `meter.pricing_rate`, `meter.usage_event`, `tenant.fiscal_period`, `workflow.run` | Replace FKs with `TEXT` cols + app-validate. Replace JOINs with `sdk-meter` service call (`getRates(catalog_id)`) and ClickHouse for usage rollups. |
| **sdk-media** | `vault.key`, `vault.encounter_key_seal` (5 refs) | Replace FK with `TEXT`. Call `sdk-vault.resolveKey()` instead of joining. |
| **sdk-identity-resolver** | `tenant.*`, `identity.*`, `persona.*`, `consent.receipt` (10 JOINs) | **This is by design** — resolver is supposed to span schemas. Keep co-located with `sdk-tenant` + `sdk-persona` on the **Admin pool**. Don't split. |
| **sdk-data-rights** | `vault.key`, `persona.*` (4 JOINs) | Similar — DSAR fan-out needs cross-schema. Keep on Admin pool. |
| **sdk-projection** | `identity.tenant_membership`, `tenant.tenant` (4 JOINs) | Same — projection inbox needs membership lookups. Keep on Admin pool. |

### Lower priority (cosmetic / by design)

| SDK | Note |
|---|---|
| sdk-approval, connector-slack | False-positive matches on TS namespaces; ignore. |
| sdk-search → `req.auth` | False positive (TS object access, not SQL). |
| sdk-consent → `identity.person` | Single JOIN; fix with service call. |
| sdk-campaign → `projection.subject_view` | Single JOIN; fix with service call. |
| sdk-crm → `engagement.encounter` | Single JOIN; fix with service call. |
| sdk-identity → `projection.subject_view` | Used by JWT minter; co-locate with projection. |

## Recommended deployment topology

```
┌─── Admin Postgres (1 cluster, vertical scale, replicas) ────────────┐
│  schemas: routing, tenant, identity, persona, consent, projection,   │
│           data_rights, audit, vault, meter (catalogs), tenant_lc,    │
│           api_keys, policy, rebac                                    │
│  reason: cross-schema resolver + privacy + audit run here            │
└──────────────────────────────────────────────────────────────────────┘

┌─── App Pool N Postgres (horizontal — add as tenants grow) ───────────┐
│  schemas: billing, media, notification, webhook, workflow,           │
│           search, approval, engagement, event, crm,                  │
│           service_request, content, campaign, social, connector      │
│  reason: per-tenant data; sharded by tenant_id via                   │
│          routing.tenant_pool_map.app_pool_index                      │
└──────────────────────────────────────────────────────────────────────┘

┌─── Vault Postgres (HSM-adjacent, hardened) ──────────────────────────┐
│  schemas: vault (writes only — reads via API)                        │
│  reason: encryption keys never share a process with low-trust SDKs   │
└──────────────────────────────────────────────────────────────────────┘

┌─── Payment Postgres (PCI scope) ─────────────────────────────────────┐
│  schemas: payment                                                    │
│  reason: PCI audit boundary; isolate from everything else            │
└──────────────────────────────────────────────────────────────────────┘

┌─── Warehouse: ClickHouse (analytics) ────────────────────────────────┐
│  meter.usage_rollup, billing aggregates                              │
│  reason: columnar; replaces meter.usage_event aggregation            │
└──────────────────────────────────────────────────────────────────────┘
```

Each box can be its own Docker container. Same code, different env
config. `apps/projexcloud-admin` + `apps/tenant-admin` are static-export
Next.js apps fronted by a CDN.

## PgBouncer in front of every Postgres

Without PgBouncer, splitting services means `N services × M replicas × 20
conns` blows past Postgres `max_connections=100` immediately. Sample
config (`/etc/pgbouncer/pgbouncer.ini`):

```ini
[databases]
projexcloud_admin = host=pg-admin-0.internal port=5432 dbname=projexcloud
projexcloud_app_0 = host=pg-app-0.internal port=5432 dbname=projexcloud

[pgbouncer]
listen_addr = 0.0.0.0
listen_port = 6432
auth_type = scram-sha-256
auth_file = /etc/pgbouncer/userlist.txt

; Transaction pooling — each app-side connection is reused across
; clients between transactions. Compatible with our perf defaults.
pool_mode = transaction
max_client_conn = 2000
default_pool_size = 25
reserve_pool_size = 5
reserve_pool_timeout = 3

; Statement-level features incompatible with transaction pooling get
; disabled at the application layer — we never use SET LOCAL, prepared
; statements outside a tx, or LISTEN/NOTIFY (we use Redis pub/sub).
ignore_startup_parameters = extra_float_digits,application_name,options
server_idle_timeout = 60
```

Point each Node service at PgBouncer (port 6432), not Postgres directly.

## Migration ordering when SDKs split

`runMigrations([...])` currently runs all 41 SDKs serially against one
Postgres. Per-container, each service runs only its own migrations. But
some FKs cross schemas (see audit). Either:

1. **Recommended:** drop the cross-schema FK (replace with `TEXT` +
   app-validate) so each SDK's schema is self-contained.
2. **Or:** co-locate the dependent SDK with its dependency on the same
   Postgres (e.g. sdk-billing on the same cluster as sdk-meter until
   billing migrates off the FK).

The migration runner is already idempotent + SHA-tracked; running the
same migration twice on the same Postgres is a no-op.

## Workers: separate deployment, same code

Today the gateway hosts every worker (transcode, webhook delivery, SLA
timer, dunning, retention shredder, meter verifier, DSAR SLA watcher).
For prod, copy the gateway entry-point, comment out the `app.register(...)`
calls, keep the `start*()` worker calls. One process per worker group.

Workers already coordinate via:
- `FOR UPDATE SKIP LOCKED` (sdk-webhook delivery worker, sdk-media
  transcoder, sdk-audit retention shredder)
- `pg_try_advisory_xact_lock` (sdk-approval SLA timer — added by the
  linter pass this session)

So you can run N replicas of each worker group safely.

## Provisioning checklist for a new app pool

1. Provision Postgres + 2 read replicas + PgBouncer.
2. `INSERT INTO routing.pool (pool_index, pool_family, region,
   primary_endpoint, replica_endpoints, status) VALUES ('app-N',
   'app', '<region>', '<pgbouncer-endpoint>', ARRAY[...], 'ACTIVE');`
3. Restart services (or wait for `bootstrapPoolsFromRegistry` next tick)
   so the new pool gets registered in each Node process's pool map.
4. New tenants automatically land on `app-N` when capacity-balancer
   picks it (sdk-tenant-lifecycle provision flow).

No code changes needed to add capacity.
