import { randomUUID } from 'crypto';
import { dataService } from '@projexlight/db-runtime';
import { appendAuditEntry } from '@projexlight/sdk-audit';
import type {
  LineageEdgeKind,
  LineageEmitInput,
  LineageNodeKind,
  LineageNodeRef,
  LineageEdgeRef,
  LineageChain,
  LineageChainStep,
  LineageProjectionState,
} from '@projexlight/contracts';

/**
 * sdk-lineage core service (G8 closer).
 *
 * Three responsibilities:
 *   1. emit(): atomically upsert from + to nodes, insert the edge, and (when
 *      pools differ) enqueue a cross-pool projection row — all inside one
 *      transaction. This is the load-bearing primitive every other P6B SDK
 *      calls when it produces derived data.
 *   2. chain(): synchronous in-pool ancestor walk for "show derivation for
 *      record X". Hard budget of 50ms p99 (PRD §6); BFS bounded by a hop
 *      limit so an accidentally-cyclic graph can't melt the query.
 *   3. crossPoolChain(): hydrates cross-pool ancestors from the Iceberg
 *      projection. Initial drop reads cross_pool_projection_queue (the
 *      Postgres mirror) and merges with the in-pool walk so the API is
 *      stable before Iceberg is online.
 */

/** Maximum BFS hops on chain queries; protects against pathological depth. */
const CHAIN_MAX_HOPS = parseInt(process.env.LINEAGE_CHAIN_MAX_HOPS ?? '64', 10);

/** Pool index this process belongs to — used to label freshly-inserted nodes. */
const LOCAL_POOL_INDEX = process.env.LINEAGE_LOCAL_POOL_INDEX
  ?? process.env.POOL_INDEX
  ?? 'default';

/** Audit pool — same pattern as sdk-agent-runtime (AGENT_RUNTIME_AUDIT_POOL). */
const LINEAGE_AUDIT_POOL = process.env.LINEAGE_AUDIT_POOL || 'admin-default';

interface NodeRow {
  node_id: string;
  pool_index: string;
  kind: string;
  ref_kind: string;
  ref_id: string;
  tenant_id: string;
  created_at: Date;
}

interface EdgeRow {
  edge_id: string;
  from_node_id: string;
  to_node_id: string;
  edge_kind: string;
  producer_sdk: string;
  producer_event_id: string | null;
  trace_id: string;
  occurred_at: Date;
}

function rowToNode(r: NodeRow): LineageNodeRef {
  return {
    node_id: r.node_id,
    pool_index: r.pool_index,
    kind: r.kind as LineageNodeKind,
    ref_kind: r.ref_kind,
    ref_id: r.ref_id,
    tenant_id: r.tenant_id,
    created_at: r.created_at.toISOString(),
  };
}

function rowToEdge(r: EdgeRow): LineageEdgeRef {
  return {
    edge_id: r.edge_id,
    from_node_id: r.from_node_id,
    to_node_id: r.to_node_id,
    edge_kind: r.edge_kind as LineageEdgeKind,
    producer_sdk: r.producer_sdk,
    producer_event_id: r.producer_event_id,
    trace_id: r.trace_id,
    occurred_at: r.occurred_at.toISOString(),
  };
}

/* ============================================================
 * emit() — the primary write path. Every P6B SDK that produces
 * derived data calls this exactly once per derivation step.
 * ============================================================ */

/**
 * Insert (or reuse) the from + to nodes, then insert the edge. When the
 * resolved pools differ, also enqueue a cross_pool_projection_queue row so
 * services/lineage-projector can flush it to Iceberg.
 *
 * All work runs in one transaction — partial state would leave the in-pool
 * subgraph inconsistent with the cross-pool queue.
 */
export async function emit(input: LineageEmitInput): Promise<LineageEdgeRef> {
  if (input.from.tenant_id !== input.to.tenant_id) {
    // Cross-tenant lineage requires explicit Relationship + Consent receipt
    // per Architecture §11 and P15. We refuse silently-cross-tenant emits
    // here; callers that need a cross-tenant edge invoke the sanctioned
    // resolver flow which checks consent first.
    throw new Error(
      `[sdk-lineage] cross-tenant emit blocked: from.tenant_id=${input.from.tenant_id} != to.tenant_id=${input.to.tenant_id}`,
    );
  }

  return dataService.tx(async (q) => {
    const fromNodeId = await upsertNodeIn(q, input.from);
    const toNodeId = await upsertNodeIn(q, input.to);

    const edgeId = randomUUID();
    const edgeRow = await q<EdgeRow>(
      `INSERT INTO lineage.edge
         (edge_id, from_node_id, to_node_id, edge_kind, producer_sdk,
          producer_event_id, trace_id, occurred_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, now())
       RETURNING edge_id, from_node_id, to_node_id, edge_kind, producer_sdk,
                 producer_event_id, trace_id, occurred_at`,
      [
        edgeId,
        fromNodeId,
        toNodeId,
        input.edge_kind,
        input.producer_sdk,
        input.producer_event_id ?? null,
        input.trace_id,
      ],
    );

    // Detect cross-pool: look at the two nodes' pool_index. We rely on the
    // upsert above (which sets pool_index for newly-inserted nodes) plus a
    // re-read for the existing ones — both come back in one SELECT.
    const pools = await q<{ node_id: string; pool_index: string }>(
      `SELECT node_id, pool_index FROM lineage.node WHERE node_id = ANY($1)`,
      [[fromNodeId, toNodeId]],
    );
    const fromPool = pools.rows.find((p) => p.node_id === fromNodeId)?.pool_index ?? LOCAL_POOL_INDEX;
    const toPool = pools.rows.find((p) => p.node_id === toNodeId)?.pool_index ?? LOCAL_POOL_INDEX;

    if (fromPool !== toPool) {
      await q(
        `INSERT INTO lineage.cross_pool_projection_queue
           (queue_id, edge_id, source_pool, target_pool, state)
         VALUES ($1, $2, $3, $4, 'pending')`,
        [randomUUID(), edgeId, fromPool, toPool],
      );
    }

    return rowToEdge(edgeRow.rows[0]);
  });
}

/** Idempotent node upsert keyed by (ref_kind, ref_id). */
async function upsertNodeIn(
  q: <R extends Record<string, unknown>>(sql: string, params?: unknown[]) => Promise<{ rows: R[] }>,
  spec: LineageEmitInput['from'],
): Promise<string> {
  const existing = await q<{ node_id: string }>(
    `SELECT node_id FROM lineage.node WHERE ref_kind = $1 AND ref_id = $2`,
    [spec.ref_kind, spec.ref_id],
  );
  if (existing.rows.length > 0) return existing.rows[0].node_id;

  const inserted = await q<{ node_id: string }>(
    `INSERT INTO lineage.node
       (node_id, pool_index, kind, ref_kind, ref_id, tenant_id)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (ref_kind, ref_id) DO UPDATE SET ref_kind = EXCLUDED.ref_kind
     RETURNING node_id`,
    [randomUUID(), LOCAL_POOL_INDEX, spec.kind, spec.ref_kind, spec.ref_id, spec.tenant_id],
  );
  return inserted.rows[0].node_id;
}

/* ============================================================
 * chain() — synchronous in-pool ancestor walk.
 * ============================================================ */

/** Resolve a (ref_kind, ref_id) to its node, then BFS ancestors. */
export async function chain(ref_kind: string, ref_id: string): Promise<LineageChain> {
  const t0 = Date.now();

  const root = await dataService.one<NodeRow>(
    `SELECT node_id, pool_index, kind, ref_kind, ref_id, tenant_id, created_at
       FROM lineage.node WHERE ref_kind = $1 AND ref_id = $2`,
    [ref_kind, ref_id],
  );
  if (!root) {
    return { ref_kind, ref_id, steps: [], in_pool_ms: Date.now() - t0, cross_pool_ms: 0 };
  }

  const steps = await walkAncestorsInPool(root.node_id);
  return {
    ref_kind,
    ref_id,
    steps,
    in_pool_ms: Date.now() - t0,
    cross_pool_ms: 0,
  };
}

/**
 * BFS walk: starting at the target node, follow lineage.edge.to_node_id =
 * current backwards to find producers. Bounded by CHAIN_MAX_HOPS. Cycles
 * are detected via a visited set; the same edge is never returned twice.
 *
 * One SQL round-trip per hop level keeps the round-trip count predictable
 * at depth — typical chains in PRD §5.6 examples are 3-5 hops.
 */
async function walkAncestorsInPool(rootNodeId: string): Promise<LineageChainStep[]> {
  const visitedEdges = new Set<string>();
  const visitedNodes = new Set<string>([rootNodeId]);
  let frontier: string[] = [rootNodeId];
  const steps: LineageChainStep[] = [];

  for (let hop = 0; hop < CHAIN_MAX_HOPS && frontier.length > 0; hop++) {
    const rows = await dataService.rows<{
      edge_id: string;
      from_node_id: string;
      to_node_id: string;
      edge_kind: string;
      producer_sdk: string;
      producer_event_id: string | null;
      trace_id: string;
      occurred_at: Date;
      from_pool: string;
      from_kind: string;
      from_ref_kind: string;
      from_ref_id: string;
      from_tenant: string;
      from_created_at: Date;
      to_pool: string;
      to_kind: string;
      to_ref_kind: string;
      to_ref_id: string;
      to_tenant: string;
      to_created_at: Date;
    }>(
      `SELECT e.edge_id, e.from_node_id, e.to_node_id, e.edge_kind,
              e.producer_sdk, e.producer_event_id, e.trace_id, e.occurred_at,
              nf.pool_index AS from_pool, nf.kind AS from_kind,
              nf.ref_kind  AS from_ref_kind, nf.ref_id AS from_ref_id,
              nf.tenant_id AS from_tenant,   nf.created_at AS from_created_at,
              nt.pool_index AS to_pool, nt.kind AS to_kind,
              nt.ref_kind  AS to_ref_kind, nt.ref_id AS to_ref_id,
              nt.tenant_id AS to_tenant,   nt.created_at AS to_created_at
         FROM lineage.edge e
         JOIN lineage.node nf ON nf.node_id = e.from_node_id
         JOIN lineage.node nt ON nt.node_id = e.to_node_id
        WHERE e.to_node_id = ANY($1)`,
      [frontier],
    );

    const nextFrontier: string[] = [];
    for (const r of rows) {
      if (visitedEdges.has(r.edge_id)) continue;
      visitedEdges.add(r.edge_id);

      steps.push({
        edge: {
          edge_id: r.edge_id,
          from_node_id: r.from_node_id,
          to_node_id: r.to_node_id,
          edge_kind: r.edge_kind as LineageEdgeKind,
          producer_sdk: r.producer_sdk,
          producer_event_id: r.producer_event_id,
          trace_id: r.trace_id,
          occurred_at: r.occurred_at.toISOString(),
        },
        from_node: {
          node_id: r.from_node_id,
          pool_index: r.from_pool,
          kind: r.from_kind as LineageNodeKind,
          ref_kind: r.from_ref_kind,
          ref_id: r.from_ref_id,
          tenant_id: r.from_tenant,
          created_at: r.from_created_at.toISOString(),
        },
        to_node: {
          node_id: r.to_node_id,
          pool_index: r.to_pool,
          kind: r.to_kind as LineageNodeKind,
          ref_kind: r.to_ref_kind,
          ref_id: r.to_ref_id,
          tenant_id: r.to_tenant,
          created_at: r.to_created_at.toISOString(),
        },
        cross_pool: r.from_pool !== r.to_pool,
      });

      if (!visitedNodes.has(r.from_node_id)) {
        visitedNodes.add(r.from_node_id);
        nextFrontier.push(r.from_node_id);
      }
    }
    frontier = nextFrontier;
  }

  return steps;
}

/* ============================================================
 * crossPoolChain() — same idea but reads from the Iceberg projection.
 * Until Iceberg is online we read the queue mirror, which has every
 * cross-pool edge we've ever emitted regardless of projection state.
 * ============================================================ */

export interface CrossPoolChain {
  ref_kind: string;
  ref_id: string;
  edges: Array<LineageEdgeRef & { source_pool: string; target_pool: string; state: LineageProjectionState }>;
  query_ms: number;
}

/**
 * Walk only the cross-pool segment. Useful when the caller has already
 * resolved the in-pool chain via chain() and wants the cross-pool
 * extension. Returns the edges with their projection state so dashboards
 * can flag still-pending cross-pool work.
 */
export async function crossPoolChain(ref_kind: string, ref_id: string): Promise<CrossPoolChain> {
  const t0 = Date.now();
  const root = await dataService.one<{ node_id: string }>(
    `SELECT node_id FROM lineage.node WHERE ref_kind = $1 AND ref_id = $2`,
    [ref_kind, ref_id],
  );
  if (!root) {
    return { ref_kind, ref_id, edges: [], query_ms: Date.now() - t0 };
  }

  const rows = await dataService.rows<EdgeRow & { source_pool: string; target_pool: string; state: LineageProjectionState }>(
    `WITH RECURSIVE ancestors AS (
        SELECT e.edge_id, e.from_node_id, e.to_node_id, e.edge_kind,
               e.producer_sdk, e.producer_event_id, e.trace_id, e.occurred_at,
               q.source_pool, q.target_pool, q.state
          FROM lineage.edge e
          JOIN lineage.cross_pool_projection_queue q ON q.edge_id = e.edge_id
         WHERE e.to_node_id = $1
        UNION
        SELECT e.edge_id, e.from_node_id, e.to_node_id, e.edge_kind,
               e.producer_sdk, e.producer_event_id, e.trace_id, e.occurred_at,
               q.source_pool, q.target_pool, q.state
          FROM lineage.edge e
          JOIN lineage.cross_pool_projection_queue q ON q.edge_id = e.edge_id
          JOIN ancestors a ON e.to_node_id = a.from_node_id
     )
     SELECT * FROM ancestors`,
    [root.node_id],
  );

  return {
    ref_kind,
    ref_id,
    edges: rows.map((r) => ({
      edge_id: r.edge_id,
      from_node_id: r.from_node_id,
      to_node_id: r.to_node_id,
      edge_kind: r.edge_kind as LineageEdgeKind,
      producer_sdk: r.producer_sdk,
      producer_event_id: r.producer_event_id,
      trace_id: r.trace_id,
      occurred_at: r.occurred_at.toISOString(),
      source_pool: r.source_pool,
      target_pool: r.target_pool,
      state: r.state,
    })),
    query_ms: Date.now() - t0,
  };
}

/* ============================================================
 * Projector worker support — called by services/lineage-projector.
 * Exposed from sdk-lineage so the worker doesn't need its own SQL.
 * ============================================================ */

export interface ProjectionClaim {
  queue_id: string;
  edge_id: string;
  source_pool: string;
  target_pool: string;
  attempts: number;
  enqueued_at: string;
}

/**
 * Claim up to `batchSize` pending queue rows for this worker using
 * SELECT FOR UPDATE SKIP LOCKED. Safe to call from N worker pods —
 * each row is handed to exactly one worker until the transaction
 * commits or rolls back.
 *
 * Caller is expected to call markProjected() or markFailed() per row.
 */
export async function claimProjectionBatch(
  batchSize: number,
  client: {
    query: <R extends Record<string, unknown>>(sql: string, params?: unknown[]) => Promise<{ rows: R[] }>;
  },
): Promise<ProjectionClaim[]> {
  const rows = await client.query<{
    queue_id: string;
    edge_id: string;
    source_pool: string;
    target_pool: string;
    attempts: number;
    enqueued_at: Date;
  }>(
    `SELECT queue_id, edge_id, source_pool, target_pool, attempts, enqueued_at
       FROM lineage.cross_pool_projection_queue
      WHERE state = 'pending'
      ORDER BY enqueued_at
      FOR UPDATE SKIP LOCKED
      LIMIT $1`,
    [batchSize],
  );
  return rows.rows.map((r) => ({
    queue_id: r.queue_id,
    edge_id: r.edge_id,
    source_pool: r.source_pool,
    target_pool: r.target_pool,
    attempts: r.attempts,
    enqueued_at: r.enqueued_at.toISOString(),
  }));
}

export async function markProjected(queue_id: string): Promise<void> {
  await dataService.query(
    `UPDATE lineage.cross_pool_projection_queue
        SET state = 'projected',
            projected_at = now(),
            last_error = NULL
      WHERE queue_id = $1`,
    [queue_id],
  );
  await safeAudit({
    event_type: 'lineage.projection.completed.v1',
    payload: { queue_id },
  });
}

export async function markFailed(queue_id: string, error_message: string): Promise<void> {
  await dataService.query(
    `UPDATE lineage.cross_pool_projection_queue
        SET state = 'failed',
            attempts = attempts + 1,
            last_error = $2
      WHERE queue_id = $1`,
    [queue_id, error_message.slice(0, 1024)],
  );
  await safeAudit({
    event_type: 'lineage.projection.failed.v1',
    payload: { queue_id, error_message },
  });
}

/**
 * Re-queue a row that was retryable (e.g. transient Iceberg outage).
 * Increments attempts but keeps state='pending' so it gets picked up again.
 */
export async function rescheduleProjection(queue_id: string, error_message: string): Promise<void> {
  await dataService.query(
    `UPDATE lineage.cross_pool_projection_queue
        SET attempts = attempts + 1,
            last_error = $2
      WHERE queue_id = $1`,
    [queue_id, error_message.slice(0, 1024)],
  );
}

/* ============================================================
 * Internal — audit emission with a never-throw safety net so that
 * lineage write failures never cascade to caller SDKs.
 * ============================================================ */

async function safeAudit(input: { event_type: string; payload: Record<string, unknown> }): Promise<void> {
  try {
    await appendAuditEntry({
      event_type: input.event_type,
      payload: input.payload,
      pool_index: LINEAGE_AUDIT_POOL,
      actor_kind: 'service',
      actor_id: 'sdk-lineage',
    });
  } catch (err) {
    console.warn('[sdk-lineage] audit emit failed (non-fatal):', err);
  }
}
