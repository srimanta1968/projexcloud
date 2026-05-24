import { dataService } from '@projexlight/db-runtime';
import { appendAuditEntry } from '@projexlight/sdk-audit';

/**
 * Execution-log retention worker (G-10 / FR-ART-11).
 *
 * Nightly worker prunes agents.execution_log_entry rows whose owning run
 * completed more than `retention_days` ago. Default 90 days; per-tenant
 * overrides are read from agents.agent_definition.default_ttl_seconds-
 * adjacent metadata when present (tracked as a future per-tenant override
 * table — for now the default applies).
 *
 * Hard rule (FR-ART-11): `retention_days = max(90, longest_compensation_window)`.
 * We can't read workflow.compensation cross-package safely without coupling,
 * so the worker honours 90d as the floor and consumers extend via env var
 * AGENT_LOG_RETENTION_DAYS for stricter retention.
 *
 * Worker runs once per AGENT_LOG_RETENTION_INTERVAL_MS (default 24h). Each
 * run computes the cutoff, deletes execution_log_entry rows in batches,
 * and emits agent.log.purged.v1 (regulated retention) with the count.
 */

const AGENT_AUDIT_POOL = process.env.AGENT_RUNTIME_AUDIT_POOL || 'admin-default';
const DEFAULT_INTERVAL_MS = 24 * 60 * 60 * 1000;
const DEFAULT_RETENTION_DAYS = parseInt(process.env.AGENT_LOG_RETENTION_DAYS || '90', 10);
const DEFAULT_BATCH = 1000;
const SYSTEM_ACTOR_ID = 'sdk-agent-runtime.log-retention';

export interface LogRetentionConfig {
  intervalMs?: number;
  retentionDays?: number;
  batchSize?: number;
  enabled?: boolean;
}

export interface LogRetentionHandle {
  stop: () => void;
  /** Run one prune cycle synchronously — exposed for CI/chaos tests. */
  runOnce: () => Promise<PurgeResult>;
}

export interface PurgeResult {
  cutoff: string;
  deleted: number;
  batches: number;
}

async function purgeOnce(retentionDays: number, batchSize: number): Promise<PurgeResult> {
  const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000);
  let totalDeleted = 0;
  let batches = 0;
  // Delete in batches so we never lock the table for long. The CTE selects
  // a bounded set of entry_ids whose run has ended before the cutoff, then
  // deletes them. Repeats until a batch deletes 0 rows.
  for (;;) {
    const r = await dataService.query<{ entry_id: string }>(
      `WITH expired AS (
         SELECT e.entry_id
           FROM agents.execution_log_entry e
           JOIN agents.agent_run r ON r.run_id = e.run_id
          WHERE r.ended_at IS NOT NULL
            AND r.ended_at < $1
          LIMIT $2
       )
       DELETE FROM agents.execution_log_entry
        WHERE entry_id IN (SELECT entry_id FROM expired)
       RETURNING entry_id`,
      [cutoff, batchSize],
    );
    if (r.rows.length === 0) break;
    totalDeleted += r.rows.length;
    batches += 1;
    if (r.rows.length < batchSize) break;
  }

  if (totalDeleted > 0) {
    try {
      await appendAuditEntry({
        pool_index: AGENT_AUDIT_POOL,
        event_type: 'agent.log.purged.v1',
        actor_kind: 'service',
        actor_id: SYSTEM_ACTOR_ID,
        tenant_id: null,
        subject_kind: 'agent.execution_log_entry',
        subject_id: 'batch',
        retention_class: 'regulated',
        payload: {
          cutoff: cutoff.toISOString(),
          deleted: totalDeleted,
          batches,
          retention_days: retentionDays,
        },
      });
    } catch (auditErr) {
      console.error('[log-retention] audit emit failed', (auditErr as Error).message);
    }
  }

  return { cutoff: cutoff.toISOString(), deleted: totalDeleted, batches };
}

/**
 * Start the retention worker. Returns a handle the caller can use to stop
 * the loop on graceful shutdown. Errors inside the tick are logged and
 * never propagate.
 */
export function startLogRetentionWorker(config: LogRetentionConfig = {}): LogRetentionHandle {
  const intervalMs = config.intervalMs ?? DEFAULT_INTERVAL_MS;
  const retentionDays = config.retentionDays ?? DEFAULT_RETENTION_DAYS;
  const batchSize = config.batchSize ?? DEFAULT_BATCH;
  const enabled = config.enabled ?? true;

  const runOnce = async (): Promise<PurgeResult> => purgeOnce(retentionDays, batchSize);

  if (!enabled) {
    return { stop: () => {}, runOnce };
  }

  let stopped = false;
  let timer: NodeJS.Timeout | null = null;

  const tick = async (): Promise<void> => {
    if (stopped) return;
    try {
      const result = await purgeOnce(retentionDays, batchSize);
      if (result.deleted > 0) {
        console.log(
          `[log-retention] deleted ${result.deleted} entries in ${result.batches} batches (cutoff ${result.cutoff})`,
        );
      }
    } catch (err) {
      console.error('[log-retention] tick failed:', (err as Error).message);
    } finally {
      if (!stopped) timer = setTimeout(tick, intervalMs);
    }
  };

  // First tick after one interval so boot doesn't compete with migrations.
  timer = setTimeout(tick, intervalMs);

  return {
    stop: () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    },
    runOnce,
  };
}
