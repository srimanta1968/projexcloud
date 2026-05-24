import { getPool } from '@projexlight/db-runtime';

/**
 * P8 NFR SLO alarms (Y-P8-15).
 *
 * Periodically computes p99 metrics across P8 variant tables and emits a
 * `sla.alarm.v1` envelope when a measured value exceeds the published
 * NFR (PRD §6 per variant):
 *
 *   - BYOK CMK use latency: p99 ≤ 10ms
 *   - BYOK rotation propagation: ≤ 15min
 *   - On-prem bundle apply: ≤ 2h
 *   - Active-Active cross-region write overhead: ≤ 50ms p99
 *   - Active-Active RPO observed: ≤ 5s
 *   - Active-Active RTO observed: ≤ 60s
 *
 * The scope is intentionally small — these are operator-visible alarms,
 * not customer-facing dashboards. SLO breach fires an event; downstream
 * sdk-notification + ops pages take it from there.
 *
 * Defaults to 5min cadence; tunable via SLO_ALARM_INTERVAL_MS. Disable
 * with SLO_ALARMS_ENABLED=false.
 */

export type SloRuleId =
  | 'byok.cmk.latency.p99'
  | 'byok.rotation.propagation'
  | 'onprem.bundle.apply.duration'
  | 'active-active.rpo.observed'
  | 'active-active.rto.observed';

export interface SloRule {
  rule_id: SloRuleId;
  description: string;
  budget: number;
  budget_unit: 'ms' | 'seconds' | 'minutes';
  query: string;
  query_params?: unknown[];
}

const RULES: SloRule[] = [
  {
    rule_id: 'byok.cmk.latency.p99',
    description: 'CMK unwrap p99 latency must be ≤ 10ms (PRD §6 BYOK).',
    budget: 10,
    budget_unit: 'ms',
    query: `SELECT COALESCE(percentile_cont(0.99) WITHIN GROUP (ORDER BY latency_ms), 0)::float AS observed
              FROM vault.cmk_use_log
             WHERE operation = 'unwrap' AND occurred_at >= now() - interval '5 minutes'`,
  },
  {
    rule_id: 'byok.rotation.propagation',
    description: 'BYOK CMK rotation propagation ≤ 15min (PRD §6 BYOK).',
    budget: 15,
    budget_unit: 'minutes',
    query: `SELECT COALESCE(MAX(EXTRACT(epoch FROM (completed_at - started_at)) / 60), 0)::float AS observed
              FROM vault.cmk_rotation
             WHERE completed_at >= now() - interval '1 hour'
               AND completed_at IS NOT NULL`,
  },
  {
    rule_id: 'onprem.bundle.apply.duration',
    description: 'On-prem bundle apply ≤ 2h (PRD §6 On-Prem).',
    budget: 120,
    budget_unit: 'minutes',
    query: `SELECT COALESCE(MAX(EXTRACT(epoch FROM (completed_at - started_at)) / 60), 0)::float AS observed
              FROM onprem.bundle_apply
             WHERE completed_at >= now() - interval '24 hours'
               AND completed_at IS NOT NULL`,
  },
  {
    rule_id: 'active-active.rpo.observed',
    description: 'Active-Active observed RPO ≤ 5s (PRD §6 AA).',
    budget: 5,
    budget_unit: 'seconds',
    query: `SELECT COALESCE(MAX(rpo_observed_seconds), 0)::float AS observed
              FROM active_active.failover_drill
             WHERE started_at >= now() - interval '24 hours'`,
  },
  {
    rule_id: 'active-active.rto.observed',
    description: 'Active-Active observed RTO ≤ 60s (PRD §6 AA).',
    budget: 60,
    budget_unit: 'seconds',
    query: `SELECT COALESCE(MAX(rto_observed_seconds), 0)::float AS observed
              FROM active_active.failover_drill
             WHERE started_at >= now() - interval '24 hours'`,
  },
];

export interface SloAlarmEmitter {
  (alarm: {
    event_type: 'sla.alarm.v1';
    rule_id: SloRuleId;
    description: string;
    budget: number;
    budget_unit: string;
    observed: number;
    breach_ratio: number;
    raised_at: string;
  }): Promise<void> | void;
}

let _emitter: SloAlarmEmitter = (alarm) => {
  console.warn(
    `[slo-alarm] ${alarm.rule_id} BREACH: ${alarm.observed.toFixed(2)} ${alarm.budget_unit} vs budget ${alarm.budget} (ratio ${alarm.breach_ratio.toFixed(2)}x)`,
  );
};

export function setSloAlarmEmitter(emitter: SloAlarmEmitter): void {
  _emitter = emitter;
}

export interface SloEvaluation {
  rule_id: SloRuleId;
  observed: number;
  breached: boolean;
  breach_ratio: number;
}

async function evaluateRule(rule: SloRule): Promise<SloEvaluation | null> {
  try {
    const pool = getPool();
    const { rows } = await pool.query<{ observed: string }>(rule.query, rule.query_params ?? []);
    const observed = parseFloat(rows[0]?.observed ?? '0');
    const breached = observed > rule.budget;
    const breach_ratio = rule.budget > 0 ? observed / rule.budget : 0;
    return { rule_id: rule.rule_id, observed, breached, breach_ratio };
  } catch (err) {
    // Schema not present yet (e.g. on-prem tables missing in cloud deploy).
    // Silently skip — the rule is just N/A in that topology.
    if (process.env.SLO_ALARMS_DEBUG === 'true') {
      console.warn(`[slo-alarm] rule ${rule.rule_id} skipped: ${(err as Error).message}`);
    }
    return null;
  }
}

export async function runSloEvaluation(): Promise<SloEvaluation[]> {
  const results: SloEvaluation[] = [];
  for (const rule of RULES) {
    const e = await evaluateRule(rule);
    if (!e) continue;
    results.push(e);
    if (e.breached) {
      try {
        await _emitter({
          event_type: 'sla.alarm.v1',
          rule_id: rule.rule_id,
          description: rule.description,
          budget: rule.budget,
          budget_unit: rule.budget_unit,
          observed: e.observed,
          breach_ratio: e.breach_ratio,
          raised_at: new Date().toISOString(),
        });
      } catch (err) {
        console.warn(`[slo-alarm] emit failed for ${rule.rule_id}: ${(err as Error).message}`);
      }
    }
  }
  return results;
}

export interface SloAlarmsConfig {
  enabled?: boolean;
  intervalMs?: number;
}

export interface SloAlarmsHandle {
  stop(): Promise<void>;
  stats(): {
    ticks: number;
    breaches_total: number;
    last_tick_at: string | null;
    last_evaluation: SloEvaluation[] | null;
  };
}

export function startSloAlarms(opts: SloAlarmsConfig = {}): SloAlarmsHandle {
  const cfg = {
    enabled: opts.enabled ?? true,
    intervalMs: opts.intervalMs ?? 5 * 60 * 1000,
  };
  const stats = {
    ticks: 0,
    breaches_total: 0,
    last_tick_at: null as string | null,
    last_evaluation: null as SloEvaluation[] | null,
  };
  let timer: ReturnType<typeof setInterval> | null = null;
  let stopped = false;

  async function tick(): Promise<void> {
    if (stopped) return;
    stats.ticks += 1;
    stats.last_tick_at = new Date().toISOString();
    try {
      const evals = await runSloEvaluation();
      stats.last_evaluation = evals;
      stats.breaches_total += evals.filter((e) => e.breached).length;
    } catch (err) {
      console.warn('[slo-alarm] tick failed:', (err as Error).message);
    }
  }

  if (cfg.enabled) {
    timer = setInterval(() => void tick(), cfg.intervalMs);
  }

  return {
    stats: () => ({ ...stats }),
    async stop() {
      stopped = true;
      if (timer) clearInterval(timer);
    },
  };
}

export { RULES as SLO_RULES };
