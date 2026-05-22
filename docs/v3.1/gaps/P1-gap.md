● Here's a concrete fix plan for each gap — what to build, what infra to provision, and where each artifact lives.

Gap 1 · Vault chaos-shred test suite (AC-1, AC-2, AC-3) — ~1 week

No infra needed. Pure test code against the existing schema.

Stack: Vitest + @testcontainers/postgresql (spins up an ephemeral Postgres per suite; no shared state).

Files to add:
packages/sdk-vault/
├── tests/
│ ├── chaos/
│ │ ├── setup.ts # testcontainers Postgres + migrate runner
│ │ ├── ac-1-person-key-shred.test.ts # Issue person key → 3 DEKs wrapped by it → shred → assert all rows status='shredded' and kms_ref IS NULL
│ │ ├── ac-2-encounter-shred.test.ts # Open 2 encounters → seal one → assert sealed encounter undecryptable, other intact
│ │ └── ac-3-pool-kek-shred.test.ts # Issue 2 pool KEKs → DEKs under each → shred one pool's KEK → assert only that pool's DEKs affected
│ └── vitest.config.ts
└── package.json # add: vitest, @testcontainers/postgresql, @testcontainers/core

Acceptance assertion per test (AC-1 example):
expect(personKey.state).toBe('shredded');
expect(personKey.kms_ref).toBeNull();
const wrapped = await query(`SELECT key_id, state FROM vault.key WHERE parent_key_id IN (...)`);
expect(wrapped.every(k => k.state === 'shredded')).toBe(true);
const auditRow = await query(`SELECT entry_hash FROM audit.entry WHERE subject_id = $1`, [personKey.key_id]);
expect(auditRow).toHaveLength(1);

Order: chaos tests are an exit gate — must pass for P1 sign-off but don't block downstream code. Ship after Wave 2 reaches a quiet point.

---

Gap 2 · Kafka + ClickHouse rollups (FR-MET-3, AC-10) — ~2-3 weeks

Needs infra: Redpanda (Kafka-compatible) + ClickHouse Cloud or self-hosted.

Step 1 — docker-compose for dev:
services:
redpanda:
image: redpandadata/redpanda:latest
command: redpanda start --smp 1 --memory 1G --reserve-memory 0M --node-id 0 --check=false --kafka-addr PLAINTEXT://0.0.0.0:9092 --advertise-kafka-addr PLAINTEXT://redpanda:9092
ports: ["9092:9092", "9644:9644"]
clickhouse:
image: clickhouse/clickhouse-server:latest
ports: ["8123:8123", "9000:9000"]
volumes: ["./infra/clickhouse/init:/docker-entrypoint-initdb.d"]

Step 2 — new runtime packages:
packages/
├── kafka-runtime/ # @projexlight/kafka-runtime (kafkajs wrapper)
│ └── src/index.ts # initProducer(), getProducer(), createConsumer(groupId, topics)
└── clickhouse-runtime/ # @projexlight/clickhouse-runtime
└── src/index.ts # initClient(), query(), insert(rows)

Step 3 — ClickHouse schema (infra/clickhouse/init/01-meter-rollups.sql):
CREATE TABLE meter.usage_event (event_id String, sku String, units Decimal64(6),
tenant_id String, pool_index String, app_id String, occurred_at DateTime,
...) ENGINE = MergeTree() PARTITION BY (toYYYYMM(occurred_at), pool_index) ORDER BY (tenant_id, sku, occurred_at);
CREATE MATERIALIZED VIEW meter.usage_hourly ENGINE = SummingMergeTree() ...;
CREATE MATERIALIZED VIEW meter.usage_daily ENGINE = SummingMergeTree() ...;
CREATE MATERIALIZED VIEW meter.usage_monthly ENGINE = SummingMergeTree() ...;

Step 4 — wire sdk-meter:
// services/api-gateway/src/app.ts
const producer = await initKafkaProducer({ brokers: config.kafka.brokers });
setEmitter(async (event) => {
await producer.send({ topic: 'usage.events.v1', messages: [{ key: event.dimensions.tenant_id, value: JSON.stringify(event) }] });
});

Step 5 — rewrite meter-collector as Kafka consumer + ClickHouse writer; preserve the Postgres usage_ledger_day hash chain as the verifiable receipts layer.

Step 6 — reconciliation job for AC-10:
tools/usage-reconciler/ # nightly job
└── src/index.ts # SELECT count(\*) FROM meter.usage_event WHERE day=X vs SELECT event_count FROM meter.usage_ledger_day WHERE day=X

---

Gap 3 · OC-1..OC-10 lint rules + @cross_pool_sanctioned (AC-7, AC-13) — ~2 weeks

No infra. Pure ESLint plugin + TypeScript-aware rules.

Files to add:
tools/lint-rules/
├── src/
│ ├── index.ts # plugin entry
│ ├── rules/
│ │ ├── oc-1-meter-decorator-required.ts # AST scan: every exported async method without @meter fails
│ │ ├── oc-2-registered-event-type.ts # check string-literal event_type args against contracts EVENT_TYPE_REGISTRY
│ │ ├── oc-3-no-raw-pg-client.ts # forbid `new Pool()` / `new Client()` outside @projexlight/db-runtime
│ │ ├── oc-4-no-cross-sdk-import.ts # sdk-X may import contracts/db-runtime/sdk-identity (auth) only
│ │ ├── oc-5-cross-pool-sanctioned.ts # any function using two `withTenant` calls needs @cross_pool_sanctioned decorator
│ │ ├── oc-6-no-env-file.ts # forbid .env in published packages
│ │ ├── oc-7-zod-schema-required.ts # contracts types must export a matching zSchema
│ │ ├── oc-8-rls-on-tenant-tables.ts # any CREATE TABLE with tenant_id must ALTER TABLE ENABLE ROW LEVEL SECURITY
│ │ ├── oc-9-no-direct-kms.ts # forbid aws-sdk/kms imports outside sdk-secrets
│ │ └── oc-10-event-envelope-shape.ts # any emit must use EventEnvelope shape
│ └── tests/ # known-good + known-bad fixtures per rule
└── package.json # uses @typescript-eslint/utils

Wire into root:
// .eslintrc.json
{
"plugins": ["@projexlight/lint-rules"],
"extends": ["plugin:@projexlight/lint-rules/recommended"]
}

@cross_pool_sanctioned decorator lives in @projexlight/contracts:
export function cross_pool_sanctioned(reason: 'resolver' | 'dsar' | 'analytics' | 'lineage') {
return function (\_target: unknown, \_ctx: ClassMethodDecoratorContext) {
// marker only — the lint rule checks for its presence
};
}

Sample known-bad test (rule oc-3):
// tests/oc-3/bad/raw-pg.ts
import { Client } from 'pg';
const c = new Client(); // <-- lint rule should flag this

---

Gap 4 · Pool router Redis pub/sub fanout (AC-6) — ~3 days

Needs infra: Redis (already needed for Gap 2's quota counter).

Step 1 — docker-compose:
services:
redis:
image: redis:7-alpine
ports: ["6379:6379"]

Step 2 — new package:
packages/redis-runtime/
└── src/index.ts # initClient(), getClient(), publish(channel, msg), subscribe(channel, handler)

Step 3 — RedisRouteCache implements existing RouteCache interface:
packages/sdk-pool-router/src/services/redisRouteCache.ts
export class RedisRouteCache implements RouteCache {
constructor(private redis: Redis) {
redis.duplicate().subscribe('pool:status-flip', (poolIndex) => this.invalidatePool(poolIndex));
}
async get(t, a) { return JSON.parse(await this.redis.get(`tenant:${t}:pool:${a}`)) }
async set(t, a, v, ttl) { await this.redis.set(`tenant:${t}:pool:${a}`, JSON.stringify(v), 'PX', ttl) }
async invalidatePool(idx) { /_ SCAN + DEL all keys pointing at this pool _/ }
}

Step 4 — wire status-flip publisher in routing.pool_lifecycle_event insert path:
// In a sdk-pool-router service helper
async function recordLifecycleEvent(...) {
await dataService.query('INSERT INTO routing.pool_lifecycle_event ...');
await getRedis().publish('pool:status-flip', pool_index);
}

Step 5 — api-gateway startup:
const redis = initRedis(config.redis);
setCache(new RedisRouteCache(redis), 300_000);

Acceptance test: spin two api-gateway replicas → change pool status on replica A → assert replica B's cache cleared within 1s.

---

Gap 5 · k6 load tests for §6 NFRs — ~1 week

No infra beyond k6. Runs against running api-gateway.

Files:
tests/load/
├── docker-compose.k6.yml # runs k6 against the live gateway
├── meter-gate-p99.js # AC-8: 10k req/s, assert http_req_duration p99 < 2ms
├── pool-router-warm.js # AC-5: 10 VUs × 1000 resolves/60s after warmup → p99 < 5ms
├── pool-router-cold.js # AC-5: FLUSHALL Redis → first 100 resolves → p99 < 20ms
├── audit-write-throughput.js # 50k events/sec sustained for 60s → no errors, ledger count matches
├── meter-end-to-end.js # AC-9: emit 10k events → wait 60s → assert 10k rows in ClickHouse
├── usage-idempotency.js # AC-9: re-send last 100 events → rollup count unchanged
└── run-all.sh # orchestrator

Example k6 script:
import http from 'k6/http';
import { check } from 'k6';
export const options = {
scenarios: { gate: { executor: 'constant-arrival-rate', rate: 10000, timeUnit: '1s', duration: '30s', preAllocatedVUs: 50 } },
thresholds: { 'http_req_duration{name:meter-check}': ['p(99)<2'] }
};
export default function() {
const r = http.post(`${__ENV.BASE}/api/meter/health`, null, { tags: { name: 'meter-check' } });
check(r, { 'status 200': (r) => r.status === 200 });
}

CI integration: GitHub Actions workflow nightly-load.yml runs every night at 2am UTC, posts results to a Grafana board.

---

Gap 6 · Frontend foundation packages — ~3 weeks

No infra. Pure package work; can ship incrementally.

Files to add (~3 packages):

packages/i18n/ # @projexlight/i18n (~3 days)
├── src/
│ ├── index.ts # loadLocale(tenant_id, locale) → resolved messages
│ ├── formatter.ts # ICU MessageFormat wrapper (uses intl-messageformat)
│ └── react.tsx # <I18nProvider>, useTranslation() hook
└── locales/
├── en-US.json
├── es-ES.json
└── ...

packages/design-system/ # @projexlight/design-system (~2 weeks — copy shadcn/ui)
├── src/components/ # Button, Input, Card, Table, Modal, Form, Dialog, Toast, etc.
├── src/lib/cn.ts # className utility
├── src/native/ # react-native-web bridges for mobile parity
├── tailwind.config.ts
└── package.json # deps: @radix-ui/\*, class-variance-authority, tailwindcss

packages/branding/ # @projexlight/branding (~3 days)
├── src/
│ ├── index.ts # resolveBrand(domain) → BrandConfig
│ ├── BrandingProvider.tsx # React context; reads from tenant.tenant.brand_domain
│ └── tokens.ts # CSS variables generator

Migrate apps/tenant-workspace to consume these packages instead of inline styles. Each component swap is incremental.

---

Gap 7 · Registry semver publish pipeline (AC-17) — ~1 week

Needs infra: private npm registry (Verdaccio for dev; Cloudsmith/GitHub Packages for prod).

Step 1 — docker-compose adds Verdaccio for local dev:
services:
verdaccio:
image: verdaccio/verdaccio:latest
ports: ["4873:4873"]
volumes: ["./infra/verdaccio/conf:/verdaccio/conf", "verdaccio_storage:/verdaccio/storage"]

Step 2 — Changesets:
pnpm add -Dw @changesets/cli
pnpm changeset init

Creates .changeset/config.json and the .changeset/ working directory. Each PR that changes a package adds a markdown file describing the bump.

Step 3 — root scripts:
// package.json
"scripts": {
"changeset": "changeset",
"version-packages": "changeset version",
"release": "pnpm build && changeset publish"
}

Step 4 — root .npmrc:
@projexlight:registry=http://localhost:4873 # dev
//npm.projexcloud.com/:\_authToken=${NPM_TOKEN} # prod

Step 5 — GitHub Actions:

# .github/workflows/release.yml

on: { push: { branches: [main] } }
jobs:
release:
runs-on: ubuntu-latest
steps: - uses: actions/checkout@v4 - uses: pnpm/action-setup@v2 - run: pnpm install - uses: changesets/action@v1
with:
publish: pnpm release
env:
NPM_TOKEN: ${{ secrets.NPM_TOKEN }}

Acceptance: npm view @projexlight/contracts version returns 1.0.0 after the first release run.

---

Recommended Order (effort + dependency)

┌─────┬───────────────────────────┬───────────┬────────────────────────────────────────────────────────┐
│ # │ Gap │ Effort │ Unblocks │
├─────┼───────────────────────────┼───────────┼────────────────────────────────────────────────────────┤
│ 1 │ Pool router Redis pub/sub │ 3 days │ Multi-replica horizontal scaling, AC-6 │
├─────┼───────────────────────────┼───────────┼────────────────────────────────────────────────────────┤
│ 2 │ Vault chaos tests │ 1 week │ AC-1/2/3 phase-exit gate │
├─────┼───────────────────────────┼───────────┼────────────────────────────────────────────────────────┤
│ 3 │ k6 load tests │ 1 week │ AC-5, AC-8, AC-9 — verifies NFR §6 targets │
├─────┼───────────────────────────┼───────────┼────────────────────────────────────────────────────────┤
│ 4 │ Registry semver pipeline │ 1 week │ AC-17 + lets Wave 2 packages publish │
├─────┼───────────────────────────┼───────────┼────────────────────────────────────────────────────────┤
│ 5 │ OC-1..OC-10 lint rules │ 2 weeks │ AC-7, AC-13 — locks the doctrine into CI │
├─────┼───────────────────────────┼───────────┼────────────────────────────────────────────────────────┤
│ 6 │ Kafka + ClickHouse │ 2-3 weeks │ FR-MET-3, AC-10 — true production telemetry │
├─────┼───────────────────────────┼───────────┼────────────────────────────────────────────────────────┤
│ 7 │ Frontend foundation pkgs │ 3 weeks │ Polish; only blocks the admin portals which land later │
└─────┴───────────────────────────┴───────────┴────────────────────────────────────────────────────────┘

Critical-path note: Gap 6 (Kafka/ClickHouse) is the biggest single item but it's prerequisite for the §6 NFRs in Gap 3 (k6 load tests) — you can't validate "10k events end-to-end in
ClickHouse rollup ≤60s" without the pipeline. Order #3 and #6 are coupled — do Kafka/ClickHouse first if you want real NFR proof; otherwise k6 only verifies the in-process Postgres
path.
