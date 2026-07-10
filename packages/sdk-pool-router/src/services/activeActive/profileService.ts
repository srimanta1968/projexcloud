import crypto from 'crypto';
import { getPool } from '@projexlight/db-runtime';
import type {
  ReplicationMode,
  ActiveActiveProfileRef,
  ReplicationStreamRef,
  FailoverDrillRef,
} from '@projexlight/contracts';

/**
 * Active-Active profile + replication stream + failover drill orchestrator
 * (P8 Variant D · FR-AA-1..7).
 *
 * Default per-SDK replication mode mapping per PRD §5.D:
 *   - sync           : audit, payment (strong consistency required)
 *   - async          : search, notification, telemetry (eventually consistent)
 *   - single-region  : identity, encounter (OLTP stays home; reads go via replica)
 *
 * The caller can override per-SDK at activation time. updateReplicationLag()
 * is called by the per-region replica probe (out-of-band) so the dashboard
 * can show actual vs target lag.
 */

export const DEFAULT_REPLICATION_MAP: Record<string, ReplicationMode> = {
  'sdk-audit': 'sync',
  'sdk-payment': 'sync',
  'sdk-search': 'async',
  'sdk-notification': 'async',
  'sdk-telemetry': 'async',
  'sdk-identity': 'single-region',
  'sdk-engagement': 'single-region',
};

export interface ActiveActiveEmitter {
  (event: {
    event_type:
      | 'active-active.profile.activated.v1'
      | 'active-active.failover.drill.v1'
      | 'active-active.tier.downgraded.v1';
    profile_id: string;
    tenant_id: string;
    payload: Record<string, unknown>;
    occurred_at: string;
  }): Promise<void> | void;
}

let _emitter: ActiveActiveEmitter = (event) => {
  console.log(`[active-active] would emit ${event.event_type} profile=${event.profile_id} (no emitter)`);
};

export function setActiveActiveEmitter(emitter: ActiveActiveEmitter): void {
  _emitter = emitter;
}

export interface ActivateProfileInput {
  tenant_id: string;
  home_region: string;
  paired_regions: string[];
  contract_addendum_ref: string;
  rpo_target_seconds?: number;
  rto_target_seconds?: number;
  /** Optional per-SDK overrides; missing entries use DEFAULT_REPLICATION_MAP. */
  replication_overrides?: Record<string, ReplicationMode>;
}

async function rowToProfile(row: {
  profile_id: string;
  tenant_id: string;
  home_region: string;
  paired_regions: string[];
  rpo_target_seconds: number;
  rto_target_seconds: number;
  contract_addendum_ref: string;
  activated_at: Date;
}): Promise<ActiveActiveProfileRef> {
  return {
    profile_id: row.profile_id,
    tenant_id: row.tenant_id,
    tier: 'tier-g+',
    home_region: row.home_region,
    paired_regions: row.paired_regions,
    rpo_target_seconds: row.rpo_target_seconds,
    rto_target_seconds: row.rto_target_seconds,
    contract_addendum_ref: row.contract_addendum_ref,
    activated_at: row.activated_at.toISOString(),
  };
}

export async function activateProfile(input: ActivateProfileInput): Promise<ActiveActiveProfileRef> {
  const profileId = `aap_${crypto.randomBytes(10).toString('hex')}`;
  const pool = getPool();

  const { rows } = await pool.query<{
    profile_id: string;
    tenant_id: string;
    home_region: string;
    paired_regions: string[];
    rpo_target_seconds: number;
    rto_target_seconds: number;
    contract_addendum_ref: string;
    activated_at: Date;
  }>(
    `INSERT INTO active_active.profile
       (profile_id, tenant_id, home_region, paired_regions,
        rpo_target_seconds, rto_target_seconds, contract_addendum_ref)
     VALUES ($1, $2::uuid, $3, $4, $5, $6, $7)
     RETURNING profile_id, tenant_id::text AS tenant_id, home_region,
               paired_regions, rpo_target_seconds, rto_target_seconds,
               contract_addendum_ref, activated_at`,
    [
      profileId,
      input.tenant_id,
      input.home_region,
      input.paired_regions,
      input.rpo_target_seconds ?? 5,
      input.rto_target_seconds ?? 60,
      input.contract_addendum_ref,
    ],
  );

  // Initialize replication streams per the default map (with overrides).
  const merged: Record<string, ReplicationMode> = { ...DEFAULT_REPLICATION_MAP, ...(input.replication_overrides ?? {}) };
  for (const [sdkKind, mode] of Object.entries(merged)) {
    const streamId = `aas_${crypto.randomBytes(10).toString('hex')}`;
    await pool.query(
      `INSERT INTO active_active.replication_stream
         (stream_id, profile_id, sdk_kind, mode)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (profile_id, sdk_kind) DO UPDATE SET mode = EXCLUDED.mode`,
      [streamId, profileId, sdkKind, mode],
    );
  }

  // Link the tenant's routing map to this profile.
  await pool.query(
    `UPDATE routing.tenant_pool_map
        SET active_active_profile_id = $2
      WHERE tenant_id = $1::uuid`,
    [input.tenant_id, profileId],
  );

  const profile = await rowToProfile(rows[0]);
  await _emitter({
    event_type: 'active-active.profile.activated.v1',
    profile_id: profileId,
    tenant_id: input.tenant_id,
    payload: { home_region: input.home_region, paired_regions: input.paired_regions },
    occurred_at: profile.activated_at,
  });
  return profile;
}

export async function getProfile(tenantId: string): Promise<ActiveActiveProfileRef | null> {
  const pool = getPool();
  const { rows } = await pool.query<{
    profile_id: string;
    tenant_id: string;
    home_region: string;
    paired_regions: string[];
    rpo_target_seconds: number;
    rto_target_seconds: number;
    contract_addendum_ref: string;
    activated_at: Date;
  }>(
    `SELECT profile_id, tenant_id::text AS tenant_id, home_region,
            paired_regions, rpo_target_seconds, rto_target_seconds,
            contract_addendum_ref, activated_at
       FROM active_active.profile WHERE tenant_id = $1::uuid`,
    [tenantId],
  );
  if (rows.length === 0) return null;
  return rowToProfile(rows[0]);
}

export async function listReplicationStreams(profileId: string): Promise<ReplicationStreamRef[]> {
  const pool = getPool();
  const { rows } = await pool.query<{
    stream_id: string;
    sdk_kind: string;
    mode: string;
    lag_seconds_p99: string;
    updated_at: Date;
  }>(
    `SELECT stream_id, sdk_kind, mode, lag_seconds_p99::text, updated_at
       FROM active_active.replication_stream
      WHERE profile_id = $1
      ORDER BY sdk_kind`,
    [profileId],
  );
  return rows.map((r) => ({
    stream_id: r.stream_id,
    profile_id: profileId,
    sdk_kind: r.sdk_kind,
    mode: r.mode as ReplicationMode,
    lag_seconds_p99: parseFloat(r.lag_seconds_p99),
    updated_at: r.updated_at.toISOString(),
  }));
}

export async function updateReplicationLag(input: {
  profile_id: string;
  sdk_kind: string;
  lag_seconds_p99: number;
}): Promise<void> {
  const pool = getPool();
  await pool.query(
    `UPDATE active_active.replication_stream
        SET lag_seconds_p99 = $3, updated_at = now()
      WHERE profile_id = $1 AND sdk_kind = $2`,
    [input.profile_id, input.sdk_kind, input.lag_seconds_p99],
  );
}

export interface RunFailoverDrillInput {
  profile_id: string;
  to_region: string;
  /** Optional override of from_region; defaults to profile.home_region. */
  from_region?: string;
}

/**
 * Run a failover drill. Measures RPO/RTO (in this scaffold: timing of the
 * synthetic flip; in production, the probe loop measures actual replica
 * lag at the start + write-resume latency at the end). Triggers tier
 * downgrade if either target is missed for two consecutive drills.
 */
export async function runFailoverDrill(input: RunFailoverDrillInput): Promise<FailoverDrillRef> {
  const pool = getPool();
  const profile = await pool.query<{
    tenant_id: string;
    home_region: string;
    rpo_target_seconds: number;
    rto_target_seconds: number;
  }>(
    `SELECT tenant_id::text AS tenant_id, home_region,
            rpo_target_seconds, rto_target_seconds
       FROM active_active.profile WHERE profile_id = $1`,
    [input.profile_id],
  );
  if (profile.rows.length === 0) {
    throw new Error(`[active-active] profile ${input.profile_id} not found`);
  }
  const fromRegion = input.from_region ?? profile.rows[0].home_region;

  // Snapshot the worst replication lag across sync streams for this
  // profile — that's the floor for RPO observed.
  const lagRes = await pool.query<{ max_lag: string }>(
    `SELECT COALESCE(MAX(lag_seconds_p99), 0)::text AS max_lag
       FROM active_active.replication_stream
      WHERE profile_id = $1 AND mode = 'sync'`,
    [input.profile_id],
  );
  const rpoObserved = parseFloat(lagRes.rows[0].max_lag);

  const drillId = `aad_${crypto.randomBytes(10).toString('hex')}`;
  const auditEntryId = `aud_${crypto.randomBytes(8).toString('hex')}`;
  const t0 = Date.now();

  await pool.query(
    `INSERT INTO active_active.failover_drill
       (drill_id, profile_id, from_region, to_region,
        rpo_observed_seconds, audit_entry_id)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [drillId, input.profile_id, fromRegion, input.to_region, rpoObserved, auditEntryId],
  );

  // Simulate the failover work. In a real drill: cut traffic, promote
  // replica, resume writes. Here: a tiny sleep so RTO is measurable.
  await new Promise((resolve) => setTimeout(resolve, 50));
  const rtoObserved = (Date.now() - t0) / 1000;

  const passed =
    rpoObserved <= profile.rows[0].rpo_target_seconds &&
    rtoObserved <= profile.rows[0].rto_target_seconds;

  // Check for two-strike tier downgrade.
  let tierDowngradeTriggered = false;
  if (!passed) {
    const recent = await pool.query<{ failures: string }>(
      `SELECT COUNT(*)::text AS failures
         FROM active_active.failover_drill
        WHERE profile_id = $1 AND passed = FALSE
          AND started_at >= now() - interval '60 days'`,
      [input.profile_id],
    );
    if (parseInt(recent.rows[0].failures, 10) >= 2) {
      tierDowngradeTriggered = true;
      await _emitter({
        event_type: 'active-active.tier.downgraded.v1',
        profile_id: input.profile_id,
        tenant_id: profile.rows[0].tenant_id,
        payload: { reason: 'two consecutive failed drills', drill_id: drillId },
        occurred_at: new Date().toISOString(),
      });
    }
  }

  const { rows: done } = await pool.query<{ resumed_at: Date; started_at: Date }>(
    `UPDATE active_active.failover_drill
        SET resumed_at = now(),
            rto_observed_seconds = $2,
            passed = $3,
            tier_downgrade_triggered = $4
      WHERE drill_id = $1
      RETURNING resumed_at, started_at`,
    [drillId, rtoObserved, passed, tierDowngradeTriggered],
  );

  await _emitter({
    event_type: 'active-active.failover.drill.v1',
    profile_id: input.profile_id,
    tenant_id: profile.rows[0].tenant_id,
    payload: {
      drill_id: drillId,
      from_region: fromRegion,
      to_region: input.to_region,
      rpo_observed_seconds: rpoObserved,
      rto_observed_seconds: rtoObserved,
      passed,
    },
    occurred_at: done[0].resumed_at.toISOString(),
  });

  return {
    drill_id: drillId,
    profile_id: input.profile_id,
    from_region: fromRegion,
    to_region: input.to_region,
    started_at: done[0].started_at.toISOString(),
    resumed_at: done[0].resumed_at.toISOString(),
    rpo_observed_seconds: rpoObserved,
    rto_observed_seconds: rtoObserved,
    passed,
    audit_entry_id: auditEntryId,
    tier_downgrade_triggered: tierDowngradeTriggered,
  };
}

/**
 * Monthly drill scheduler. Picks a random paired region per tenant and
 * runs the drill. Disabled in tests via ACTIVE_ACTIVE_DRILL_ENABLED=false.
 */
export interface DrillSchedulerConfig {
  enabled?: boolean;
  /** Cadence in ms. Default 30d. */
  intervalMs?: number;
}

export interface DrillSchedulerHandle {
  stop(): Promise<void>;
  stats(): { runs: number; last_drill_at: string | null };
}

export function startMonthlyDrillScheduler(opts: DrillSchedulerConfig = {}): DrillSchedulerHandle {
  const cfg = {
    enabled: opts.enabled ?? true,
    intervalMs: opts.intervalMs ?? 30 * 24 * 60 * 60 * 1000,
  };
  const stats = { runs: 0, last_drill_at: null as string | null };
  let timer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;

  // Node's setTimeout/setInterval store the delay in a 32-bit signed int.
  // Any value > 2^31-1 (~24.8 days) silently clamps to 1ms — which turned the
  // 30-day cadence into a ~1000/sec drill flood that drained the DB pool and
  // crash-looped the gateway. Chunk long waits below the limit instead.
  const MAX_TIMER_MS = 2_147_483_647;

  async function tick(): Promise<void> {
    if (stopped) return;
    stats.runs += 1;
    try {
      const pool = getPool();
      const { rows } = await pool.query<{ profile_id: string; paired_regions: string[] }>(
        `SELECT profile_id, paired_regions FROM active_active.profile`,
      );
      for (const profile of rows) {
        const target = profile.paired_regions[Math.floor(Math.random() * profile.paired_regions.length)];
        if (!target) continue;
        try {
          const drill = await runFailoverDrill({ profile_id: profile.profile_id, to_region: target });
          stats.last_drill_at = drill.resumed_at;
        } catch (err) {
          console.warn(`[active-active] drill failed for profile=${profile.profile_id}: ${(err as Error).message}`);
        }
      }
    } catch (err) {
      console.warn('[active-active] drill scheduler tick failed:', (err as Error).message);
    }
  }

  // Self-rescheduling timer that survives delays beyond the 32-bit cap by
  // splitting them into <=MAX_TIMER_MS chunks, then runs one tick per full
  // interval and re-arms.
  function scheduleAfter(remainingMs: number): void {
    if (stopped) return;
    const delay = Math.min(remainingMs, MAX_TIMER_MS);
    timer = setTimeout(() => {
      if (stopped) return;
      const left = remainingMs - delay;
      if (left > 0) {
        scheduleAfter(left);
      } else {
        void tick().finally(() => scheduleAfter(cfg.intervalMs));
      }
    }, delay);
  }

  if (cfg.enabled) {
    scheduleAfter(cfg.intervalMs);
  }

  return {
    stats: () => ({ ...stats }),
    async stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
    },
  };
}
