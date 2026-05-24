import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { getClickHouse } from '@projexlight/clickhouse-runtime';

/**
 * Bootstraps the sdk-diagnostic-telemetry ClickHouse schema (FR-DIA-4).
 * Same idempotent contract as sdk-trace/chBootstrap.ts — sha256-tracked,
 * forward-only, runs on every boot, skips already-applied files. Throws
 * on hash drift to enforce the forward-only doctrine.
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
  await getClickHouse().command({
    query: `
      CREATE DATABASE IF NOT EXISTS diagnostic;
      CREATE TABLE IF NOT EXISTS diagnostic.ch_migrations (
        sdk String, filename String, sha256 String, applied_at DateTime DEFAULT now()
      ) ENGINE = MergeTree ORDER BY (sdk, filename)
    `,
  });
}

interface ChMigrationRow {
  sha256: string;
}

async function alreadyApplied(
  sdk: string,
  filename: string,
): Promise<{ applied: boolean; sha256?: string }> {
  const result = await getClickHouse().query({
    query: `SELECT sha256 FROM diagnostic.ch_migrations
            WHERE sdk = {sdk:String} AND filename = {filename:String} LIMIT 1`,
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

  const statements = sql
    .split(/;\s*\n/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && !s.startsWith('--'));

  for (const stmt of statements) {
    await getClickHouse().command({ query: stmt });
  }

  await getClickHouse().insert({
    table: 'diagnostic.ch_migrations',
    values: [{ sdk, filename, sha256: hash }],
    format: 'JSONEachRow',
  });
  console.log(`[ch-migrator] applied ${sdk}/${filename}`);
}

/**
 * Run all pending ClickHouse migrations for sdk-diagnostic-telemetry.
 * Idempotent. Call from api-gateway boot after initClickHouse.
 */
export async function bootstrapDiagnosticClickHouseSchema(): Promise<void> {
  await ensureChTrackingTable();
  const files = listChMigrations(chMigrationsDir);
  for (const file of files) {
    await applyOne('sdk-diagnostic-telemetry', file);
  }
}

export { chMigrationsDir };
