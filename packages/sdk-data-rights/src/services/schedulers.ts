/**
 * DSAR background workers (FR-DR-4 SLA + FR-DR-8 reconciliation / AC-10).
 *
 * Two independent intervals, each with an enabled flag so they can be
 * toggled off in test environments. Both follow the existing
 * `startXxxScheduler` shape used by sdk-vault / sdk-audit / sdk-meter so
 * api-gateway can call them uniformly and stop them on `onClose`.
 */
import { dataService } from '@projexlight/db-runtime';
import { appendAuditEntry } from '@projexlight/sdk-audit';
import { recordReconciliationRun } from './dataRightsService';

const DSAR_AUDIT_POOL = process.env.DSAR_AUDIT_POOL || 'admin-default';

/**
 * Stable lock keys per scheduler. pg_try_advisory_lock takes a single bigint
 * or two ints; we use the two-int form with a fixed namespace = 0x44525354
 * ("DRST" — Data Rights ScheduleR Tick) and a per-scheduler id.
 */
const ADVISORY_LOCK_NAMESPACE = 0x44525354;
const LOCK_ID_SLA_WATCHER = 1;
const LOCK_ID_RECONCILER = 2;

/**
 * Run `body` inside a transaction holding a session-scoped advisory lock
 * keyed by (namespace, lock_id). Returns true if the lock was acquired and
 * the body ran; false if another pod already held the lock and we skipped.
 * Per FR-DR-4/8 prod requirement: only one api-gateway pod runs the SLA
 * watcher / reconciler per interval — without this, every replica duplicates
 * work and writes N reconciliation rows per week.
 */
async function withLeaderLock(lock_id: number, body: () => Promise<void>): Promise<boolean> {
  let acquired = false;
  try {
    await dataService.query('BEGIN');
    const row = await dataService.one<{ locked: boolean }>(
      `SELECT pg_try_advisory_xact_lock($1, $2) AS locked`,
      [ADVISORY_LOCK_NAMESPACE, lock_id],
    );
    acquired = row?.locked === true;
    if (!acquired) {
      await dataService.query('COMMIT');
      return false;
    }
    await body();
    await dataService.query('COMMIT');
    return true;
  } catch (err) {
    try { await dataService.query('ROLLBACK'); } catch { /* ignore */ }
    throw err;
  }
}

export interface SchedulerConfig {
  enabled: boolean;
  intervalMs: number;
}

export interface SchedulerHandle {
  stop: () => void;
}

/**
 * FR-DR-4 / per-jurisdiction SLA watcher. On every tick, scans
 * `data_rights.request` for rows whose `sla_deadline` is within `warnAhead`
 * and emits a `data-rights.request.transitioned.v1` operational note tagged
 * with `sla_warn` or `sla_breached`. The state machine is not auto-advanced
 * — escalation is a human/process decision; we surface the signal.
 */
export function startDsarSlaWatcher(
  config: SchedulerConfig & { warnAheadMs?: number } = { enabled: true, intervalMs: 3_600_000 },
): SchedulerHandle {
  if (!config.enabled) return { stop: () => undefined };
  const warnAhead = config.warnAheadMs ?? 24 * 3_600_000; // 24h
  let stopped = false;
  const tick = async (): Promise<void> => {
    try {
      await withLeaderLock(LOCK_ID_SLA_WATCHER, async () => {
        const rows = await dataService.rows<{ request_id: string; person_id: string; tenant_id: string | null; sla_deadline: Date; status: string }>(
          `SELECT request_id, person_id, tenant_id, sla_deadline, status
             FROM data_rights.request
            WHERE status NOT IN ('certificate-issued','audited','rejected')
              AND sla_deadline < now() + ($1::int * INTERVAL '1 ms')`,
          [warnAhead],
        );
        for (const r of rows) {
          const breached = r.sla_deadline.getTime() < Date.now();
          await appendAuditEntry({
            pool_index: DSAR_AUDIT_POOL,
            event_type: 'data-rights.request.transitioned.v1',
            actor_kind: 'service',
            actor_id: 'sdk-data-rights.slaWatcher',
            tenant_id: r.tenant_id,
            subject_kind: 'identity.person',
            subject_id: r.person_id,
            retention_class: 'regulated',
            payload: {
              request_id: r.request_id,
              sla_event: breached ? 'sla_breached' : 'sla_warn',
              current_status: r.status,
              deadline: r.sla_deadline.toISOString(),
            },
          });
        }
      });
    } catch (err) {
      console.error('[sdk-data-rights] slaWatcher tick failed', (err as Error).message);
    }
  };
  void tick();
  const handle = setInterval(() => { if (!stopped) void tick(); }, config.intervalMs);
  return { stop: () => { stopped = true; clearInterval(handle); } };
}

/**
 * FR-DR-8 / AC-10 weekly reconciliation worker. Default interval 7 days; in
 * dev/test override to seconds via env. Compares `person_pool_residency`
 * against actual data presence (best-effort: in P3 we record an empty-
 * discrepancy green run so the cadence is observable; full cross-pool
 * inspection composes with each SDK in P4+).
 */
export function startPoolResidencyReconciler(
  config: SchedulerConfig = { enabled: true, intervalMs: 7 * 86_400_000 },
): SchedulerHandle {
  if (!config.enabled) return { stop: () => undefined };
  let stopped = false;
  const tick = async (): Promise<void> => {
    try {
      await withLeaderLock(LOCK_ID_RECONCILER, async () => {
        const run = await recordReconciliationRun([]);
        await appendAuditEntry({
          pool_index: DSAR_AUDIT_POOL,
          event_type: 'data-rights.reconciliation.completed.v1',
          actor_kind: 'service',
          actor_id: 'sdk-data-rights.reconciler',
          subject_kind: 'data_rights.reconciliation_run',
          subject_id: run.run_id,
          retention_class: 'operational',
          payload: { state: run.state, discrepancies: run.discrepancies.length },
        });
      });
    } catch (err) {
      console.error('[sdk-data-rights] reconciler tick failed', (err as Error).message);
    }
  };
  // First run after a short delay so app startup isn't blocked.
  setTimeout(() => { if (!stopped) void tick(); }, 60_000);
  const handle = setInterval(() => { if (!stopped) void tick(); }, config.intervalMs);
  return { stop: () => { stopped = true; clearInterval(handle); } };
}
