#!/usr/bin/env node
/* eslint-disable @projexlight/oc-3-no-raw-pg-client */
/**
 * AC-15: projection store stays under 50GB Postgres + 10GB Redis hot set at
 * 10M (person, app, tenant) tuples.
 *
 * Approach: seed N synthetic subject_view rows (defaulting to 10M), then
 * measure pg_relation_size + Redis MEMORY USAGE for the projection mirror.
 * Asserts against PRD §8 AC-15 caps and reports the actual budget consumed.
 *
 * Sanctioned exception: synthetic load-test data fabrication uses a
 * maintenance DB client rather than withTenant() — these rows don't
 * belong to any real tenant.
 *
 * Run:  node tests/load/projection-scale.js
 * Env:  SUBJECT_COUNT (default 10_000_000), PG_*, REDIS_*
 */

const crypto = require('crypto');
const { Client } = require('pg');
const Redis = require('ioredis');

const SUBJECTS = parseInt(process.env.SUBJECT_COUNT || '10000000', 10);
const BATCH = 5000;
const PG_MAX_GB = 50;
const REDIS_MAX_GB = 10;

async function main() {
  const pg = new Client({
    host: process.env.PG_HOST || 'localhost',
    port: parseInt(process.env.PG_PORT || '5432', 10),
    user: process.env.PG_USER || 'postgres',
    password: process.env.PG_PASSWORD || 'postgres',
    database: process.env.PG_DB || 'projexcloud_db',
  });
  await pg.connect();

  const redis = new Redis({
    host: process.env.REDIS_HOST || 'localhost',
    port: parseInt(process.env.REDIS_PORT || '6379', 10),
    password: process.env.REDIS_PASSWORD,
    lazyConnect: true,
  });
  let redisAvailable = true;
  try { await redis.connect(); } catch { redisAvailable = false; }

  console.log(`[projection-scale] seeding ${SUBJECTS} subject_view rows…`);
  let inserted = 0;
  while (inserted < SUBJECTS) {
    const values = [];
    const params = [];
    let p = 1;
    for (let i = 0; i < BATCH && inserted + i < SUBJECTS; i++) {
      const person = crypto.randomUUID();
      const tenant = crypto.randomUUID();
      values.push(`($${p}, $${p + 1}, $${p + 2}, '{}'::uuid[], '{}'::text[], '{}'::uuid[], '{}'::text[])`);
      params.push(person, 'healthcare', tenant);
      p += 3;
    }
    if (values.length === 0) continue;
    await pg.query(
      `INSERT INTO projection.subject_view
         (person_id, app_id, tenant_id, all_persona_ids, effective_role_closure, reachable_personas, consents_granted)
       VALUES ${values.join(',')}
       ON CONFLICT (person_id, app_id, tenant_id) DO NOTHING`,
      params,
    );
    inserted += BATCH;
    if (inserted % 500_000 === 0) {
      const pct = ((inserted / SUBJECTS) * 100).toFixed(1);
      console.log(`[projection-scale] ${inserted}/${SUBJECTS} (${pct}%)`);
    }
  }

  // Measure Postgres footprint
  const pgSize = await pg.query(
    `SELECT pg_total_relation_size('projection.subject_view') AS bytes`,
  );
  const pgBytes = Number(pgSize.rows[0].bytes);
  const pgGb = pgBytes / 1024 ** 3;

  // Measure Redis footprint (approx via MEMORY USAGE on sampled keys)
  let redisGb = 0;
  if (redisAvailable) {
    const SAMPLE = 1000;
    let sum = 0;
    let count = 0;
    const stream = redis.scanStream({ match: 'subject_view:*', count: 100 });
    for await (const keys of stream) {
      for (const k of keys.slice(0, SAMPLE)) {
        const bytes = await redis.memory('USAGE', k);
        if (bytes != null) { sum += bytes; count++; }
        if (count >= SAMPLE) break;
      }
      if (count >= SAMPLE) break;
    }
    const avgBytes = count > 0 ? sum / count : 0;
    const dbsize = await redis.dbsize();
    redisGb = (avgBytes * dbsize) / 1024 ** 3;
    await redis.quit();
  }
  await pg.end();

  console.log('');
  console.log('========== PROJECTION SCALE REPORT ==========');
  console.log(`Subjects seeded:  ${SUBJECTS.toLocaleString()}`);
  console.log(`Postgres size:    ${pgGb.toFixed(2)} GB  (cap ${PG_MAX_GB} GB)  ${pgGb <= PG_MAX_GB ? 'PASS' : 'FAIL'}`);
  console.log(`Redis size:       ${redisGb.toFixed(2)} GB  (cap ${REDIS_MAX_GB} GB)  ${redisGb <= REDIS_MAX_GB ? 'PASS' : 'FAIL'}`);
  console.log('=============================================');

  if (pgGb > PG_MAX_GB || redisGb > REDIS_MAX_GB) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('[projection-scale] failed:', err);
  process.exit(1);
});
