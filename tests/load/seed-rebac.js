#!/usr/bin/env node
/* eslint-disable @projexlight/oc-3-no-raw-pg-client */
/**
 * AC-9 graph seeder. Writes 100k personas + 10M random care-team edges
 * directly via Postgres to avoid HTTP overhead, then dumps the persona id
 * set to tests/load/personas.json for k6 to consume.
 *
 * Sanctioned exception: load-test data fabrication uses a maintenance DB
 * client rather than withTenant() — synthetic personas don't belong to any
 * real tenant. The eslint-disable above documents the carve-out.
 *
 * Run:  node tests/load/seed-rebac.js
 * Env:  PG_HOST, PG_PORT, PG_USER, PG_PASSWORD, PG_DB (defaults to docker-compose values)
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Client } = require('pg');

const PERSONAS = parseInt(process.env.PERSONA_COUNT || '100000', 10);
const EDGES    = parseInt(process.env.EDGE_COUNT    || '10000000', 10);
const BATCH    = 5000;

async function main() {
  const client = new Client({
    host: process.env.PG_HOST || 'localhost',
    port: parseInt(process.env.PG_PORT || '5432', 10),
    user: process.env.PG_USER || 'postgres',
    password: process.env.PG_PASSWORD || 'postgres',
    database: process.env.PG_DB || 'projexcloud_db',
  });
  await client.connect();

  console.log(`[seed-rebac] generating ${PERSONAS} persona ids…`);
  const personas = Array.from({ length: PERSONAS }, () => crypto.randomUUID());
  fs.writeFileSync(path.join(__dirname, 'personas.json'), JSON.stringify(personas));

  console.log(`[seed-rebac] inserting ${EDGES} care-team edges in batches of ${BATCH}…`);
  let inserted = 0;
  while (inserted < EDGES) {
    const values = [];
    const params = [];
    let p = 1;
    for (let i = 0; i < BATCH && inserted + i < EDGES; i++) {
      const a = personas[Math.floor(Math.random() * personas.length)];
      let b = personas[Math.floor(Math.random() * personas.length)];
      if (a === b) continue;
      values.push(`($${p}, $${p + 1}, 'care-team', 'active', '{}'::jsonb, FALSE)`);
      params.push(a, b);
      p += 2;
    }
    if (values.length === 0) continue;
    await client.query(
      `INSERT INTO rebac.relationship (persona_a, persona_b, kind, status, scope, cross_tenant)
       VALUES ${values.join(',')}
       ON CONFLICT DO NOTHING`,
      params,
    );
    inserted += BATCH;
    if (inserted % 100_000 === 0) {
      const pct = ((inserted / EDGES) * 100).toFixed(1);
      console.log(`[seed-rebac] ${inserted}/${EDGES} (${pct}%)`);
    }
  }

  await client.end();
  console.log('[seed-rebac] done. personas.json written; k6 ready to run.');
}

main().catch((err) => {
  console.error('[seed-rebac] failed:', err);
  process.exit(1);
});
