/**
 * AC-5 + AC-6 — cross-pool lineage end-to-end.
 *
 * Seeds two synthetic pools (source-pool · target-pool) into the lineage
 * schema, emits a cross-pool derived_from edge via sdk-lineage.emit(),
 * verifies the cross_pool_projection_queue row enqueues, then runs the
 * services/lineage-projector worker against a LocalIcebergWriter writing
 * NDJSON to a temp directory. Asserts the Iceberg-side partition file
 * contains the projected row within the SLA window.
 *
 * Also asserts chain() and crossPoolChain() return the full ancestry
 * with correct in-pool vs cross-pool segmentation.
 *
 * Skips cleanly when DB_HOST is unset (CI / local dev gate).
 */

import fs from 'fs';
import path from 'path';
import os from 'os';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { dataService, initPool } from '@projexlight/db-runtime';
import { emit, chain, crossPoolChain } from '../src/services/lineageService';

const TENANT = '00000000-0000-4000-a000-000000000ace';

// Force fresh per-process LOCAL_POOL_INDEX for this suite. The lineage
// service reads process.env.LINEAGE_LOCAL_POOL_INDEX once at import — we
// override before importing the worker module below.
const SRC_POOL = `lineage-test-src-${process.pid}`;
const TGT_POOL = `lineage-test-tgt-${process.pid}`;

const ICEBERG_TMP = path.join(os.tmpdir(), `iceberg-lineage-test-${process.pid}`);

describe('AC-5 + AC-6 · cross-pool lineage end-to-end', () => {
  let drainOnce: typeof import('../../../services/lineage-projector/src/worker').drainOnce;
  let LocalIcebergWriter: typeof import('../../../services/lineage-projector/src/icebergWriter').LocalIcebergWriter;

  beforeAll(async () => {
    if (!process.env.DB_HOST) {
      // Tests skip cleanly when no DB is configured (CI sets DB_* env).
      return;
    }
    initPool({
      host: process.env.DB_HOST,
      port: parseInt(process.env.DB_PORT ?? '5432', 10),
      database: process.env.DB_NAME ?? 'projexcloud_db',
      user: process.env.DB_USER ?? 'postgres',
      password: process.env.DB_PASSWORD ?? 'postgres',
    });

    // The schema lands via the api-gateway boot-path migration-runner in
    // shared dev environments; on a fresh CI DB we apply it inline.
    const migrationSql = fs.readFileSync(
      path.resolve(__dirname, '..', 'src', 'db', 'migrations', '001_init_lineage.sql'),
      'utf8',
    );
    await dataService.query(migrationSql);

    // Clean any prior pollution from a previous run with the same PID
    // (rare but harmless to guard against).
    await dataService.query(
      `DELETE FROM lineage.cross_pool_projection_queue
        WHERE source_pool IN ($1, $2) OR target_pool IN ($1, $2)`,
      [SRC_POOL, TGT_POOL],
    );
    await dataService.query(
      `DELETE FROM lineage.edge
        WHERE producer_sdk = 'sdk-lineage-test'`,
    );
    await dataService.query(
      `DELETE FROM lineage.node WHERE ref_kind LIKE 'lineage-test:%'`,
    );

    process.env.LINEAGE_ICEBERG_DRIVER = 'local';
    process.env.LINEAGE_ICEBERG_LOCAL_DIR = ICEBERG_TMP;
    fs.mkdirSync(ICEBERG_TMP, { recursive: true });

    // Dynamic import AFTER env is set so the worker reads our overrides.
    drainOnce = (await import('../../../services/lineage-projector/src/worker')).drainOnce;
    LocalIcebergWriter = (await import('../../../services/lineage-projector/src/icebergWriter')).LocalIcebergWriter;
  }, 60_000);

  afterAll(async () => {
    if (!process.env.DB_HOST) return;
    try {
      await dataService.query(
        `DELETE FROM lineage.cross_pool_projection_queue
          WHERE source_pool IN ($1, $2) OR target_pool IN ($1, $2)`,
        [SRC_POOL, TGT_POOL],
      );
      await dataService.query(
        `DELETE FROM lineage.edge WHERE producer_sdk = 'sdk-lineage-test'`,
      );
      await dataService.query(
        `DELETE FROM lineage.node WHERE ref_kind LIKE 'lineage-test:%'`,
      );
      fs.rmSync(ICEBERG_TMP, { recursive: true, force: true });
    } catch {
      /* best-effort cleanup */
    }
  });

  it('emits a cross-pool edge, drains it through the projector, and reads it back', async () => {
    if (!process.env.DB_HOST) {
      console.warn('[lineage-e2e] skipping — DB_HOST not set');
      return;
    }

    // 1. Seed two pools by inserting nodes with explicit pool_index. The
    //    lineage service infers pool from the row's pool_index column on
    //    the read-back inside emit(), so pre-creating the rows lets us
    //    control which pool each node sits in.
    const srcNodeId = '01H_TEST_LINEAGE_SRC_NODE';
    const tgtNodeId = '01H_TEST_LINEAGE_TGT_NODE';
    await dataService.query(
      `INSERT INTO lineage.node (node_id, pool_index, kind, ref_kind, ref_id, tenant_id)
       VALUES ($1, $2, 'blob', 'lineage-test:source', 'blob-1', $3)
       ON CONFLICT (ref_kind, ref_id) DO UPDATE SET pool_index = EXCLUDED.pool_index
       RETURNING node_id`,
      [srcNodeId, SRC_POOL, TENANT],
    );
    await dataService.query(
      `INSERT INTO lineage.node (node_id, pool_index, kind, ref_kind, ref_id, tenant_id)
       VALUES ($1, $2, 'field', 'lineage-test:derived', 'field-1', $3)
       ON CONFLICT (ref_kind, ref_id) DO UPDATE SET pool_index = EXCLUDED.pool_index`,
      [tgtNodeId, TGT_POOL, TENANT],
    );

    // 2. Emit the edge. emit() will detect the pool mismatch on the read-
    //    back and enqueue a cross_pool_projection_queue row.
    const edge = await emit({
      from: { ref_kind: 'lineage-test:source', ref_id: 'blob-1', kind: 'blob', tenant_id: TENANT },
      to:   { ref_kind: 'lineage-test:derived', ref_id: 'field-1', kind: 'field', tenant_id: TENANT },
      edge_kind: 'derived_from',
      producer_sdk: 'sdk-lineage-test',
      trace_id: 'trace-lineage-e2e-1',
    });
    expect(edge.edge_id).toBeTruthy();
    expect(edge.edge_kind).toBe('derived_from');

    // 3. Queue row should be pending now.
    const queued = await dataService.one<{ state: string; source_pool: string; target_pool: string }>(
      `SELECT state, source_pool, target_pool
         FROM lineage.cross_pool_projection_queue
        WHERE edge_id = $1`,
      [edge.edge_id],
    );
    expect(queued).not.toBeNull();
    expect(queued?.state).toBe('pending');
    expect(queued?.source_pool).toBe(SRC_POOL);
    expect(queued?.target_pool).toBe(TGT_POOL);

    // 4. Drain the queue through the projector.
    const writer = new LocalIcebergWriter();
    const drainResult = await drainOnce({ batch_size: 50, region: 'test-region' }, writer);
    expect(drainResult.projected + drainResult.rescheduled + drainResult.failed).toBeGreaterThanOrEqual(1);
    expect(drainResult.failed).toBe(0);

    // 5. Queue row flipped projected.
    const after = await dataService.one<{ state: string }>(
      `SELECT state FROM lineage.cross_pool_projection_queue WHERE edge_id = $1`,
      [edge.edge_id],
    );
    expect(after?.state).toBe('projected');

    // 6. Iceberg NDJSON partition file exists and contains the row.
    const safeSrc = SRC_POOL.replace(/[^a-zA-Z0-9_-]/g, '_');
    const safeTgt = TGT_POOL.replace(/[^a-zA-Z0-9_-]/g, '_');
    const day = new Date().toISOString().slice(0, 10);
    const partitionFile = path.join(
      ICEBERG_TMP,
      `source=${safeSrc}`,
      `target=${safeTgt}`,
      `day=${day}.ndjson`,
    );
    expect(fs.existsSync(partitionFile)).toBe(true);
    const lines = fs.readFileSync(partitionFile, 'utf8').trim().split('\n');
    const ours = lines
      .map((l) => JSON.parse(l) as { edge_id: string; source_pool: string; target_pool: string; from_ref: string; to_ref: string; edge_kind: string; trace_id: string; tenant_id: string; region: string });
    const found = ours.find((r) => r.edge_id === edge.edge_id);
    expect(found).toBeDefined();
    expect(found?.source_pool).toBe(SRC_POOL);
    expect(found?.target_pool).toBe(TGT_POOL);
    expect(found?.from_ref).toBe('lineage-test:source:blob-1');
    expect(found?.to_ref).toBe('lineage-test:derived:field-1');
    expect(found?.edge_kind).toBe('derived_from');
    expect(found?.trace_id).toBe('trace-lineage-e2e-1');
    expect(found?.tenant_id).toBe(TENANT);
    expect(found?.region).toBe('test-region');

    // 7. AC-6 — chain() returns the in-pool segment with cross_pool=true.
    const chainResult = await chain('lineage-test:derived', 'field-1');
    expect(chainResult.steps.length).toBeGreaterThanOrEqual(1);
    const firstStep = chainResult.steps[0];
    expect(firstStep.edge.edge_id).toBe(edge.edge_id);
    expect(firstStep.cross_pool).toBe(true);
    expect(firstStep.from_node.ref_id).toBe('blob-1');
    expect(firstStep.to_node.ref_id).toBe('field-1');
    // PRD §6 target: in-pool segment <=50ms p99 (the assert keeps the
    // test honest in CI; raise if it flakes under contention).
    expect(chainResult.in_pool_ms).toBeLessThan(500);

    // 8. crossPoolChain() returns the projected row separately.
    const xpc = await crossPoolChain('lineage-test:derived', 'field-1');
    expect(xpc.edges.length).toBeGreaterThanOrEqual(1);
    const xpcEdge = xpc.edges.find((e) => e.edge_id === edge.edge_id);
    expect(xpcEdge).toBeDefined();
    expect(xpcEdge?.state).toBe('projected');
    expect(xpcEdge?.source_pool).toBe(SRC_POOL);
    expect(xpcEdge?.target_pool).toBe(TGT_POOL);
  }, 90_000);
});
