import { dataService, getPool } from '@projexlight/db-runtime';
import {
  claimProjectionBatch,
  markFailed,
  markProjected,
  rescheduleProjection,
  type ProjectionClaim,
} from '@projexlight/sdk-lineage';
import { buildIcebergWriter, type IcebergWriter, type IcebergCrossPoolLineageRow } from './icebergWriter';

/**
 * Cross-pool projection worker — drains lineage.cross_pool_projection_queue
 * and writes to Iceberg warehouse.cross_pool_lineage.
 *
 * Concurrency model:
 *   - Multiple worker pods may run simultaneously
 *   - claimProjectionBatch() uses SELECT FOR UPDATE SKIP LOCKED so each row
 *     goes to exactly one worker per tick
 *   - Failed rows count attempts; after MAX_ATTEMPTS the row is parked in
 *     state='failed' and surfaces via the failed metrics endpoint
 *
 * SLO: end-to-end projection lag ≤5min p99 (PRD §6, AC-5).
 */

export interface WorkerConfig {
  /** Rows pulled per tick. */
  batchSize: number;
  /** Tick interval in ms when the queue is healthy. */
  intervalMs: number;
  /** Tick interval in ms when the last tick was empty (backoff). */
  idleIntervalMs: number;
  /** How many attempts before parking the row as 'failed'. */
  maxAttempts: number;
  /** Region tag stamped onto warehouse rows for partition pruning. */
  region: string;
}

export const DEFAULT_CONFIG: WorkerConfig = {
  batchSize: parseInt(process.env.LINEAGE_PROJECTOR_BATCH ?? '50', 10),
  intervalMs: parseInt(process.env.LINEAGE_PROJECTOR_INTERVAL_MS ?? '1000', 10),
  idleIntervalMs: parseInt(process.env.LINEAGE_PROJECTOR_IDLE_MS ?? '5000', 10),
  maxAttempts: parseInt(process.env.LINEAGE_PROJECTOR_MAX_ATTEMPTS ?? '5', 10),
  region: process.env.LINEAGE_PROJECTOR_REGION ?? 'local',
};

export interface ProjectorHandle {
  stop(): Promise<void>;
  /** Last-tick stats — used by /health and /metrics. */
  stats(): { projected: number; failed: number; rescheduled: number; lastTickAt: string | null };
}

interface QueueRowWithContext {
  claim: ProjectionClaim;
  edgeRow: {
    edge_id: string;
    edge_kind: string;
    producer_sdk: string;
    trace_id: string;
    occurred_at: Date;
    from_node_id: string;
    to_node_id: string;
    from_ref_kind: string;
    from_ref_id: string;
    from_tenant: string;
    to_ref_kind: string;
    to_ref_id: string;
    to_tenant: string;
  };
}

export function startProjectorWorker(
  config: Partial<WorkerConfig> = {},
  writer: IcebergWriter = buildIcebergWriter(),
): ProjectorHandle {
  const cfg: WorkerConfig = { ...DEFAULT_CONFIG, ...config };
  let running = true;
  let timer: NodeJS.Timeout | null = null;
  const stats = { projected: 0, failed: 0, rescheduled: 0, lastTickAt: null as string | null };

  async function tick(): Promise<void> {
    if (!running) return;

    let processedAny = false;
    try {
      // Claim + project + mark must run with the same client so the row
      // stays locked end-to-end. We use dataService.tx() so SKIP LOCKED
      // is honored per-row.
      await dataService.tx(async (q) => {
        // Adapt the tx callback's `q` to the shape claimProjectionBatch wants.
        const client = {
          query: q as <R extends Record<string, unknown>>(sql: string, params?: unknown[]) => Promise<{ rows: R[] }>,
        };
        const claims = await claimProjectionBatch(cfg.batchSize, client);
        if (claims.length === 0) return;
        processedAny = true;

        // Resolve edge + node context for every claim in one round-trip.
        const rich = await loadContext(client, claims);

        for (const item of rich) {
          try {
            const row = toIcebergRow(item, cfg.region);
            await writer.writeRow(row);
            await markProjected(item.claim.queue_id);
            stats.projected++;
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            if (item.claim.attempts + 1 >= cfg.maxAttempts) {
              await markFailed(item.claim.queue_id, msg);
              stats.failed++;
            } else {
              await rescheduleProjection(item.claim.queue_id, msg);
              stats.rescheduled++;
            }
          }
        }
      });
      stats.lastTickAt = new Date().toISOString();
    } catch (err) {
      console.error('[lineage-projector] tick failed:', err);
    }

    if (!running) return;
    const delay = processedAny ? cfg.intervalMs : cfg.idleIntervalMs;
    timer = setTimeout(tick, delay);
  }

  // Kick off the loop. First tick after intervalMs so startup is graceful.
  timer = setTimeout(tick, cfg.intervalMs);

  return {
    async stop(): Promise<void> {
      running = false;
      if (timer) clearTimeout(timer);
      await writer.flush().catch(() => undefined);
      await writer.close().catch(() => undefined);
    },
    stats(): { projected: number; failed: number; rescheduled: number; lastTickAt: string | null } {
      return { ...stats };
    },
  };
}

async function loadContext(
  client: { query: <R extends Record<string, unknown>>(sql: string, params?: unknown[]) => Promise<{ rows: R[] }> },
  claims: ProjectionClaim[],
): Promise<QueueRowWithContext[]> {
  if (claims.length === 0) return [];
  const edgeIds = claims.map((c) => c.edge_id);
  const ctxRows = await client.query<QueueRowWithContext['edgeRow']>(
    `SELECT e.edge_id, e.edge_kind, e.producer_sdk, e.trace_id, e.occurred_at,
            e.from_node_id, e.to_node_id,
            nf.ref_kind AS from_ref_kind, nf.ref_id AS from_ref_id, nf.tenant_id AS from_tenant,
            nt.ref_kind AS to_ref_kind,   nt.ref_id AS to_ref_id,   nt.tenant_id AS to_tenant
       FROM lineage.edge e
       JOIN lineage.node nf ON nf.node_id = e.from_node_id
       JOIN lineage.node nt ON nt.node_id = e.to_node_id
      WHERE e.edge_id = ANY($1)`,
    [edgeIds],
  );
  const byEdge = new Map<string, QueueRowWithContext['edgeRow']>();
  for (const r of ctxRows.rows) byEdge.set(r.edge_id, r);

  const out: QueueRowWithContext[] = [];
  for (const claim of claims) {
    const edgeRow = byEdge.get(claim.edge_id);
    if (!edgeRow) {
      // Edge vanished — possible if ON DELETE CASCADE fired between claim
      // and context load. Park it as failed so it's auditable.
      await markFailed(claim.queue_id, 'edge row missing for queue entry').catch(() => undefined);
      continue;
    }
    out.push({ claim, edgeRow });
  }
  return out;
}

function toIcebergRow(item: QueueRowWithContext, region: string): IcebergCrossPoolLineageRow {
  const e = item.edgeRow;
  return {
    edge_id: e.edge_id,
    source_pool: item.claim.source_pool,
    target_pool: item.claim.target_pool,
    from_ref: `${e.from_ref_kind}:${e.from_ref_id}`,
    to_ref: `${e.to_ref_kind}:${e.to_ref_id}`,
    edge_kind: e.edge_kind,
    producer_sdk: e.producer_sdk,
    trace_id: e.trace_id,
    // Source + target tenants must match (cross-tenant emits are blocked
    // by emit()), so either side is valid for the partition column.
    tenant_id: e.from_tenant,
    region,
    occurred_at: e.occurred_at.toISOString(),
  };
}

/** Convenience for one-shot tools (CI tests, manual triage). */
export async function drainOnce(
  config: Partial<WorkerConfig> = {},
  writer: IcebergWriter = buildIcebergWriter(),
): Promise<{ projected: number; failed: number; rescheduled: number }> {
  const cfg = { ...DEFAULT_CONFIG, ...config };
  const local = { projected: 0, failed: 0, rescheduled: 0 };

  await dataService.tx(async (q) => {
    const client = {
      query: q as <R extends Record<string, unknown>>(sql: string, params?: unknown[]) => Promise<{ rows: R[] }>,
    };
    const claims = await claimProjectionBatch(cfg.batchSize, client);
    if (claims.length === 0) return;
    const rich = await loadContext(client, claims);

    for (const item of rich) {
      try {
        const row = toIcebergRow(item, cfg.region);
        await writer.writeRow(row);
        await markProjected(item.claim.queue_id);
        local.projected++;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (item.claim.attempts + 1 >= cfg.maxAttempts) {
          await markFailed(item.claim.queue_id, msg);
          local.failed++;
        } else {
          await rescheduleProjection(item.claim.queue_id, msg);
          local.rescheduled++;
        }
      }
    }
  });

  // Keep the pool open — caller controls lifecycle.
  void getPool;
  return local;
}
