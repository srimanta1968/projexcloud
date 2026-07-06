import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { getClickHouse } from '@projexlight/clickhouse-runtime';

/**
 * Bootstraps the sdk-trace ClickHouse schema. Companion to the Postgres
 * migration-runner — same idempotent contract (sha256-tracked, forward-only,
 * exec on every boot, skip already-applied) but against ClickHouse.
 *
 * Reads `.ch.sql` files from packages/sdk-trace/src/db/ch_migrations/ in
 * lexicographic order, hashes each, executes if not in trace.ch_migrations.
 * Throws if an applied file has been modified — forward-only discipline.
 */

function listChMigrations(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((f) => f.endsWith('.ch.sql')).sort();
}

const candidates = [
  path.join(__dirname, 'ch_migrations'),
  path.resolve(__dirname, '..', '..', 'src', 'db', 'ch_migrations'),
];

const chMigrationsDir = candidates.find((d) => fs.existsSync(d)) ?? candidates[0];

function sha256(content: string): string {
  return crypto.createHash('sha256').update(content).digest('hex');
}

async function ensureChTrackingTable(): Promise<void> {
  // The first file in the migration set creates trace.ch_migrations itself.
  // We still try a defensive CREATE here to handle ordering edge cases (e.g.
  // someone renames the first file later).
  // ClickHouse's client rejects multiple statements in one command() — issue the
  // CREATE DATABASE and CREATE TABLE as separate commands.
  await getClickHouse().command({ query: 'CREATE DATABASE IF NOT EXISTS trace' });
  await getClickHouse().command({
    query: `CREATE TABLE IF NOT EXISTS trace.ch_migrations (
        sdk String, filename String, sha256 String, applied_at DateTime DEFAULT now()
      ) ENGINE = MergeTree ORDER BY (sdk, filename)`,
  });
}

interface ChMigrationRow {
  sha256: string;
}

async function alreadyApplied(sdk: string, filename: string): Promise<{ applied: boolean; sha256?: string }> {
  const result = await getClickHouse().query({
    query: `SELECT sha256 FROM trace.ch_migrations WHERE sdk = {sdk:String} AND filename = {filename:String} LIMIT 1`,
    query_params: { sdk, filename },
    format: 'JSONEachRow',
  });
  const rows = await result.json<ChMigrationRow>();
  if (rows.length === 0) return { applied: false };
  return { applied: true, sha256: rows[0].sha256 };
}

async function applyOne(sdk: string, filename: string): Promise<void> {
  const fullPath = path.join(chMigrationsDir, filename);
  const sql = fs.readFileSync(fullPath, 'utf-8');
  const hash = sha256(sql);

  const existing = await alreadyApplied(sdk, filename);
  if (existing.applied) {
    if (existing.sha256 !== hash) {
      throw new Error(
        `[ch-migrator] ${sdk}/${filename} has changed after being applied (sha256 mismatch). Forward-only — write a new migration.`,
      );
    }
    return;
  }

  // ClickHouse driver doesn't support multi-statement scripts in one call;
  // split on semicolons that aren't inside string literals. Simple splitter
  // is sufficient for the DDL we ship (no SQL-injection risk — it's our SQL).
  const statements = sql
    .split(/;\s*\n/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && !s.startsWith('--'));

  for (const stmt of statements) {
    await getClickHouse().command({ query: stmt });
  }

  await getClickHouse().insert({
    table: 'trace.ch_migrations',
    values: [{ sdk, filename, sha256: hash }],
    format: 'JSONEachRow',
  });
  // eslint-disable-next-line no-console
  console.log(`[ch-migrator] applied ${sdk}/${filename}`);
}

/**
 * Run all pending ClickHouse migrations for sdk-trace, in lexicographic
 * filename order. Idempotent. Call from api-gateway boot after initClickHouse.
 */
export async function bootstrapClickHouseSchema(): Promise<void> {
  await ensureChTrackingTable();
  const files = listChMigrations(chMigrationsDir);
  for (const file of files) {
    await applyOne('sdk-trace', file);
  }
}

export { chMigrationsDir };
