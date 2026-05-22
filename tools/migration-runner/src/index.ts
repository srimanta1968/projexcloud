import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { dataService, getPool } from '@projexlight/db-runtime';

export interface SdkMigrationSource {
  sdk: string;
  dir: string;
}

const TRACK_TABLE_DDL = `
  CREATE TABLE IF NOT EXISTS _migrations (
    id         BIGSERIAL PRIMARY KEY,
    sdk        TEXT NOT NULL,
    filename   TEXT NOT NULL,
    sha256     TEXT NOT NULL,
    applied_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (sdk, filename)
  )
`;

function sha256(content: string): string {
  return crypto.createHash('sha256').update(content).digest('hex');
}

function listSqlFiles(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
}

async function ensureTrackingTable(): Promise<void> {
  await dataService.query(TRACK_TABLE_DDL);
}

async function alreadyApplied(sdk: string, filename: string): Promise<{ applied: boolean; sha256?: string }> {
  const row = await dataService.one<{ sha256: string }>(
    'SELECT sha256 FROM _migrations WHERE sdk = $1 AND filename = $2',
    [sdk, filename],
  );
  if (!row) return { applied: false };
  return { applied: true, sha256: row.sha256 };
}

async function applyOne(sdk: string, dir: string, filename: string): Promise<void> {
  const fullPath = path.join(dir, filename);
  const sql = fs.readFileSync(fullPath, 'utf-8');
  const hash = sha256(sql);

  const existing = await alreadyApplied(sdk, filename);
  if (existing.applied) {
    if (existing.sha256 !== hash) {
      throw new Error(
        `[migrator] ${sdk}/${filename} has changed after being applied (sha256 mismatch). Forward-only — write a new migration.`,
      );
    }
    return;
  }

  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    await client.query(sql);
    await client.query(
      'INSERT INTO _migrations (sdk, filename, sha256) VALUES ($1, $2, $3)',
      [sdk, filename, hash],
    );
    await client.query('COMMIT');
    console.log(`[migrator] applied ${sdk}/${filename}`);
  } catch (err) {
    await client.query('ROLLBACK');
    throw new Error(`[migrator] failed ${sdk}/${filename}: ${(err as Error).message}`);
  } finally {
    client.release();
  }
}

/**
 * Run all pending migrations for every SDK source, in declaration order.
 * Each SDK's migrations are applied in lexicographic filename order. Idempotent.
 * Per ProjectStructure-v3.1 §6.3, SDK dependency order must be respected.
 */
export async function runMigrations(sources: SdkMigrationSource[]): Promise<void> {
  await ensureTrackingTable();
  for (const src of sources) {
    const files = listSqlFiles(src.dir);
    for (const file of files) {
      await applyOne(src.sdk, src.dir, file);
    }
  }
}
