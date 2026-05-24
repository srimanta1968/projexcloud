import { dataService } from '@projexlight/db-runtime';
import { appendAuditEntry } from '@projexlight/sdk-audit';
import { revokeToken } from './capabilityTokenIssuer';
import { sweepKillSwitchedRuns } from './killSwitch';

/**
 * Execution-TTL enforcer worker — FR-ART-5..7 / AC-4.
 *
 * Polls `agents.agent_run` on a tight interval for runs whose ttl_deadline
 * has passed while status is still 'running'. For each expired run:
 *
 *   1. Atomically transitions status -> 'terminated_ttl_expired'
 *      (UPDATE ... WHERE status='running' RETURNING — wins exactly one
 *      worker race so a multi-replica deployment stays correct without
 *      a distributed lock).
 *   2. Marks every in-flight tool invocation as cancelled and fires the
 *      tool's cancellation hook (per-tool_sku registry).
 *   3. Revokes every unused capability token belonging to the run so any
 *      tool that's still polling sees the revoke and self-cancels.
 *   4. Emits agent.run.terminated.v1 (regulated retention) and invokes
 *      the registered refund handler so sdk-meter can credit unspent
 *      tier budget for the run.
 *
 * Single-replica safe (the atomic UPDATE wins races) but designed for
 * horizontal scale-out. Index `agent_run_ttl_due_idx ON (ttl_deadline)
 * WHERE status='running'` keeps the poll O(log n) regardless of history.
 */

const AGENT_AUDIT_POOL = process.env.AGENT_RUNTIME_AUDIT_POOL || 'admin-default';
const DEFAULT_INTERVAL_MS = 1000;
const DEFAULT_BATCH = 50;
const SYSTEM_ACTOR_ID = 'sdk-agent-runtime.ttl-enforcer';

export type CancellationHook = (input: {
  run_id: string;
  invocation_id: string;
  tool_sku: string;
}) => Promise<void> | void;

const cancellationHooks = new Map<string, CancellationHook>();

/**
 * Register a per-tool cancellation hook. The TTL enforcer calls each hook
 * when a run terminates while the tool is still in flight so the tool can
 * release its own resources (HTTP request abort, child process kill, etc.).
 * Tools register once at module load; the registry is process-local.
 */
export function registerCancellationHook(tool_sku: string, hook: CancellationHook): void {
  cancellationHooks.set(tool_sku, hook);
}

export function unregisterCancellationHook(tool_sku: string): void {
  cancellationHooks.delete(tool_sku);
}

export interface RefundInput {
  run_id: string;
  tenant_id: string | null;
  agent_id: string;
  tokens_spent: number;
  cost_spent: number;
  reason: 'ttl_expired';
}

export type RefundHook = (input: RefundInput) => Promise<void> | void;

let refundHook: RefundHook | null = null;

/**
 * Register the meter refund hook. sdk-meter consumers wire this so the
 * unspent portion of a terminated run's budget is credited back. When no
 * hook is registered the TTL enforcer logs but does not block termination
 * (refund is a downstream concern, never a termination prerequisite).
 */
export function registerRefundHook(hook: RefundHook): void {
  refundHook = hook;
}

interface ExpiredRunRow {
  run_id: string;
  agent_id: string;
  tenant_id: string | null;
  persona_id: string;
  trace_id: string;
  tokens_total: number;
  cost_total: string; // pg returns NUMERIC as string
  ttl_deadline: Date;
  started_at: Date;
}

interface InFlightInvocationRow {
  invocation_id: string;
  tool_sku: string;
  capability_token_id: string;
}

async function claimAndTerminate(now: Date, batchSize: number): Promise<ExpiredRunRow[]> {
  // The atomic claim: transitions every expired run to terminated_ttl_expired
  // in one statement and returns the rows. Concurrent workers cannot claim
  // the same row twice because the WHERE clause requires status='running'.
  const r = await dataService.query<ExpiredRunRow>(
    `UPDATE agents.agent_run
        SET status = 'terminated_ttl_expired',
            ended_at = $1
      WHERE run_id IN (
        SELECT run_id FROM agents.agent_run
         WHERE status = 'running' AND ttl_deadline <= $1
         ORDER BY ttl_deadline ASC
         LIMIT $2
         FOR UPDATE SKIP LOCKED
      )
      RETURNING run_id, agent_id, tenant_id, persona_id, trace_id,
                tokens_total, cost_total, ttl_deadline, started_at`,
    [now, batchSize],
  );
  return r.rows;
}

async function listInFlightInvocations(run_id: string): Promise<InFlightInvocationRow[]> {
  const r = await dataService.query<InFlightInvocationRow>(
    `SELECT invocation_id, tool_sku, capability_token_id
       FROM agents.tool_invocation
      WHERE run_id = $1
        AND result_envelope IS NULL`,
    [run_id],
  );
  return r.rows;
}

async function cancelInvocation(row: InFlightInvocationRow, run_id: string): Promise<void> {
  await dataService.query(
    `UPDATE agents.tool_invocation
        SET outcome = 'cancelled',
            occurred_at = COALESCE(occurred_at, now())
      WHERE invocation_id = $1`,
    [row.invocation_id],
  );

  const hook = cancellationHooks.get(row.tool_sku);
  if (hook) {
    try {
      await hook({ run_id, invocation_id: row.invocation_id, tool_sku: row.tool_sku });
    } catch (hookErr) {
      console.error(
        '[ttl-enforcer] cancellation hook failed for',
        row.tool_sku,
        row.invocation_id,
        (hookErr as Error).message,
      );
    }
  }
}

async function revokeRunTokens(run_id: string): Promise<void> {
  const r = await dataService.query<{ token_id: string }>(
    `SELECT token_id FROM agents.capability_token
      WHERE run_id = $1
        AND used_at IS NULL
        AND revoked_at IS NULL`,
    [run_id],
  );
  for (const t of r.rows) {
    await revokeToken({
      token_id: t.token_id,
      reason: 'ttl_expired',
      actor_id: SYSTEM_ACTOR_ID,
      actor_kind: 'service',
    });
  }
}

async function emitTerminationEvents(run: ExpiredRunRow): Promise<void> {
  try {
    await appendAuditEntry({
      pool_index: AGENT_AUDIT_POOL,
      event_type: 'agent.run.terminated.v1',
      actor_kind: 'service',
      actor_id: SYSTEM_ACTOR_ID,
      tenant_id: run.tenant_id,
      subject_kind: 'agent.agent_run',
      subject_id: run.run_id,
      retention_class: 'regulated',
      payload: {
        agent_id: run.agent_id,
        persona_id: run.persona_id,
        trace_id: run.trace_id,
        reason: 'ttl_expired',
        ttl_deadline: run.ttl_deadline.toISOString(),
        terminated_at: new Date().toISOString(),
      },
    });
  } catch (auditErr) {
    console.error(
      '[ttl-enforcer] audit emit failed for run',
      run.run_id,
      (auditErr as Error).message,
    );
  }

  if (refundHook) {
    try {
      await refundHook({
        run_id: run.run_id,
        tenant_id: run.tenant_id,
        agent_id: run.agent_id,
        tokens_spent: run.tokens_total,
        cost_spent: parseFloat(run.cost_total),
        reason: 'ttl_expired',
      });
    } catch (refundErr) {
      console.error(
        '[ttl-enforcer] refund hook failed for run',
        run.run_id,
        (refundErr as Error).message,
      );
    }
  }
}

async function terminateOne(run: ExpiredRunRow): Promise<void> {
  // Step 1 (claimAndTerminate) already flipped status + ended_at.
  // Steps 2-4: cancel in-flight tools, revoke unused tokens, emit events.
  const invocations = await listInFlightInvocations(run.run_id);
  for (const inv of invocations) {
    await cancelInvocation(inv, run.run_id);
  }
  await revokeRunTokens(run.run_id);
  await emitTerminationEvents(run);
}

export interface TtlEnforcerConfig {
  /** Poll interval in ms. Lower = tighter AC-4 deadline adherence; default 1000. */
  intervalMs?: number;
  /** Max runs terminated per tick. Caps lock contention; default 50. */
  batchSize?: number;
  /** Hard kill switch — set false to disable the worker without removing the call. */
  enabled?: boolean;
}

export interface TtlEnforcerHandle {
  stop: () => void;
}

/**
 * Start the TTL enforcer worker. Returns a handle the caller can use to
 * stop the loop on graceful shutdown. Errors inside the tick are logged
 * and never propagate — the worker self-recovers on the next interval.
 */
export function startTtlEnforcer(config: TtlEnforcerConfig = {}): TtlEnforcerHandle {
  const intervalMs = config.intervalMs ?? DEFAULT_INTERVAL_MS;
  const batchSize = config.batchSize ?? DEFAULT_BATCH;
  const enabled = config.enabled ?? true;

  if (!enabled) {
    return { stop: () => {} };
  }

  let stopped = false;
  let timer: NodeJS.Timeout | null = null;

  const tick = async (): Promise<void> => {
    if (stopped) return;
    try {
      const expired = await claimAndTerminate(new Date(), batchSize);
      for (const run of expired) {
        if (stopped) break;
        try {
          await terminateOne(run);
        } catch (err) {
          console.error('[ttl-enforcer] terminate failed for', run.run_id, (err as Error).message);
        }
      }
      // Piggyback the kill-switch sweep on the same tick (FR-ART kill-switch).
      // Same interval (1s default) so an operator flag flip propagates to
      // every running agent within the second.
      try {
        await sweepKillSwitchedRuns();
      } catch (sweepErr) {
        console.error('[ttl-enforcer] kill-switch sweep failed:', (sweepErr as Error).message);
      }
    } catch (err) {
      console.error('[ttl-enforcer] tick failed:', (err as Error).message);
    } finally {
      if (!stopped) {
        timer = setTimeout(tick, intervalMs);
      }
    }
  };

  timer = setTimeout(tick, intervalMs);

  return {
    stop: () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    },
  };
}
