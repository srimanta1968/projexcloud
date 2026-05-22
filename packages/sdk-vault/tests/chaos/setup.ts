import fs from 'fs';
import path from 'path';
import { Client } from 'pg';
import { initPool, getPool, dataService } from '@projexlight/db-runtime';

/**
 * Chaos-test setup: reuses the existing projexcloud_postgres container by
 * creating a temporary per-run database inside it. No extra container needed.
 *
 * Each suite gets its own ephemeral database `chaos_<timestamp>_<rand>`,
 * migrations are applied, tests run, then the database is dropped. Concurrent
 * suites cannot collide; dev's main `projexcloud_db` is never touched.
 *
 * Env (defaults match docker-compose.yml):
 *   CHAOS_PG_HOST     = localhost
 *   CHAOS_PG_PORT     = 5432
 *   CHAOS_PG_USER     = postgres
 *   CHAOS_PG_PASSWORD = postgres
 *   CHAOS_PG_ADMIN_DB = postgres   (maintenance DB used to CREATE/DROP)
 */

const SDK_MIGRATION_DIRS = [
  '../../../sdk-vault/src/db/migrations',
  '../../../sdk-identity/src/db/migrations',
  '../../../sdk-pool-router/src/db/migrations',
  '../../../sdk-audit/src/db/migrations',
  '../../../sdk-meter/src/db/migrations',
  '../../../sdk-tenant/src/db/migrations',
];

export interface ChaosCtx {
  dbName: string;
  query: typeof dataService.query;
  rows: typeof dataService.rows;
  one: typeof dataService.one;
  stop: () => Promise<void>;
}

const CONFIG = {
  host: process.env.CHAOS_PG_HOST || 'localhost',
  port: parseInt(process.env.CHAOS_PG_PORT || '5432', 10),
  user: process.env.CHAOS_PG_USER || 'postgres',
  password: process.env.CHAOS_PG_PASSWORD || 'postgres',
  adminDb: process.env.CHAOS_PG_ADMIN_DB || 'postgres',
};

async function applyMigrationsFor(absDir: string): Promise<void> {
  if (!fs.existsSync(absDir)) return;
  const files = fs.readdirSync(absDir).filter((f) => f.endsWith('.sql')).sort();
  for (const f of files) {
    const sql = fs.readFileSync(path.join(absDir, f), 'utf-8');
    await getPool().query(sql);
  }
}

async function createDatabase(name: string): Promise<void> {
  // OC-3 sanctioned exception: chaos test infra needs the maintenance DB to
  // CREATE/DROP per-suite ephemeral databases. withTenant() cannot help here
  // because no tenant exists yet.
  // eslint-disable-next-line @projexlight/oc-3-no-raw-pg-client
  const admin = new Client({
    host: CONFIG.host,
    port: CONFIG.port,
    user: CONFIG.user,
    password: CONFIG.password,
    database: CONFIG.adminDb,
  });
  await admin.connect();
  try {
    await admin.query(`CREATE DATABASE "${name}"`);
  } finally {
    await admin.end();
  }
}

async function dropDatabase(name: string): Promise<void> {
  // OC-3 sanctioned exception: maintenance DB connection for DROP, same
  // rationale as createDatabase above.
  // eslint-disable-next-line @projexlight/oc-3-no-raw-pg-client
  const admin = new Client({
    host: CONFIG.host,
    port: CONFIG.port,
    user: CONFIG.user,
    password: CONFIG.password,
    database: CONFIG.adminDb,
  });
  await admin.connect();
  try {
    // Terminate other connections so DROP can proceed.
    await admin.query(
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity
       WHERE datname = $1 AND pid <> pg_backend_pid()`,
      [name],
    );
    await admin.query(`DROP DATABASE IF EXISTS "${name}"`);
  } finally {
    await admin.end();
  }
}

export async function startChaosCtx(): Promise<ChaosCtx> {
  const dbName = `chaos_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  await createDatabase(dbName);

  initPool({
    host: CONFIG.host,
    port: CONFIG.port,
    user: CONFIG.user,
    password: CONFIG.password,
    database: dbName,
    ssl: false,
    min: 1,
    max: 4,
  });

  await getPool().query('CREATE EXTENSION IF NOT EXISTS pgcrypto');

  for (const rel of SDK_MIGRATION_DIRS) {
    const abs = path.resolve(__dirname, rel);
    await applyMigrationsFor(abs);
  }

  return {
    dbName,
    query: dataService.query.bind(dataService),
    rows: dataService.rows.bind(dataService),
    one: dataService.one.bind(dataService),
    stop: async () => {
      try { await getPool().end(); } catch { /* idempotent */ }
      await dropDatabase(dbName);
    },
  };
}
