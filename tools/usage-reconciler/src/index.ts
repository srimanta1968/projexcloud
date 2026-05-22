import { dataService, initPool } from '@projexlight/db-runtime';
import { initClickHouse, query as chQuery } from '@projexlight/clickhouse-runtime';
import { loadConfig } from '@projexlight/config';

/**
 * Nightly reconciliation per AC-10: compares ClickHouse raw event count
 * against Postgres usage_ledger_day.event_count per (tenant, day). Any
 * non-zero delta is a chain-break candidate and is logged for review.
 */

interface MismatchRow {
  tenant_id: string;
  day: string;
  clickhouse_count: number;
  postgres_count: number;
  delta: number;
}

async function reconcileDay(day: string): Promise<MismatchRow[]> {
  const ch = await chQuery<{ tenant_id: string; cnt: string }>(
    `SELECT tenant_id, sum(event_count) AS cnt
       FROM meter.usage_daily
      WHERE day = {day:Date}
      GROUP BY tenant_id`,
    { day },
  );
  const chByTenant: Record<string, number> = {};
  for (const r of ch) chByTenant[r.tenant_id] = Number(r.cnt);

  const pg = await dataService.rows<{ tenant_id: string; event_count: string }>(
    `SELECT tenant_id, event_count FROM meter.usage_ledger_day WHERE day = $1::date`,
    [day],
  );

  const mismatches: MismatchRow[] = [];
  const tenants = new Set([...Object.keys(chByTenant), ...pg.map((r) => r.tenant_id)]);
  for (const tenant_id of tenants) {
    const chCnt = chByTenant[tenant_id] ?? 0;
    const pgRow = pg.find((r) => r.tenant_id === tenant_id);
    const pgCnt = pgRow ? Number(pgRow.event_count) : 0;
    if (chCnt !== pgCnt) {
      mismatches.push({ tenant_id, day, clickhouse_count: chCnt, postgres_count: pgCnt, delta: chCnt - pgCnt });
    }
  }
  return mismatches;
}

async function main(): Promise<void> {
  const config = loadConfig();
  initPool({
    host: config.db.host,
    port: config.db.port,
    database: config.db.database,
    user: config.db.user,
    password: config.db.password,
    ssl: config.db.ssl ? { rejectUnauthorized: false } : false,
    min: 1,
    max: 5,
  });
  initClickHouse({
    url: process.env.CLICKHOUSE_URL || 'http://localhost:8123',
    username: process.env.CLICKHOUSE_USER || 'default',
    password: process.env.CLICKHOUSE_PASSWORD || 'clickhouse',
    database: 'meter',
  });

  const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
  const mismatches = await reconcileDay(yesterday);
  if (mismatches.length === 0) {
    console.log(`[usage-reconciler] ${yesterday}: byte-perfect parity`);
    process.exit(0);
  }
  console.error(`[usage-reconciler] ${yesterday}: ${mismatches.length} tenant mismatches`);
  for (const m of mismatches) {
    console.error(JSON.stringify(m));
  }
  process.exit(1);
}

if (require.main === module) {
  main().catch((err) => {
    console.error('[usage-reconciler] fatal', err);
    process.exit(2);
  });
}

export { reconcileDay };
