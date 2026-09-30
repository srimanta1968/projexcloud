import { insert as chInsert, query as chQuery } from '@projexlight/clickhouse-runtime';
import { dataService } from '@projexlight/db-runtime';
import { createConsumer, getKafka } from '@projexlight/kafka-runtime';
import { createIncident, listIncidents } from '@projexlight/sdk-incident';
import { validationError } from '../models/errors';
import type { CallDetail } from './callService';
import { estimateStackProfileCost } from './stackProfileService';

/**
 * Voice analytics in ClickHouse (VA·E10 · TK-4520).
 *
 *   voice.turn_metrics  one row per answered turn, consumed from the runtime's Kafka topic
 *                       voice.turn.metrics.v1 (latencies, model, tool outcomes — no text)
 *   voice.call_facts    one row per finished call, written when the call completes: per-stage
 *                       latency, provider errors (failovers), tool errors, and cost per call
 *
 * Queryable per tenant (queryVoiceAnalytics), and a p95 regression — the last window's p95
 * time-to-first-audio well above the tenant's own trailing baseline — opens an sdk-incident.
 *
 * Cost per call: the runtime's cost_breakdown.total_usd when it reports one, else an estimate
 * from the speech catalog (the stack profile's list price per minute x duration). BYOK
 * provider spend is the tenant's own; this is for their visibility, never invoiced.
 */

const TURN_TOPIC = process.env.VOICE_TURN_TOPIC || 'voice.turn.metrics.v1';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const REGRESSION_INCIDENT_TYPE = 'voice.latency.p95_regression';

const ch = (d: Date | string | null | undefined): string => {
  const t = d ? new Date(d) : new Date();
  return t.toISOString().replace('T', ' ').replace('Z', '');
};
function pct(values: number[], p: number): number | null {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.ceil(s.length * p) - 1))];
}
const nums = (xs: (number | null | undefined)[]): number[] => xs.filter((v): v is number => typeof v === 'number' && Number.isFinite(v));

// -------------------------------------------------------------------------------- call facts

async function callCost(call: CallDetail): Promise<{ cost: number | null; source: string }> {
  const reported = Number((call.cost_breakdown as { total_usd?: unknown })?.total_usd);
  if (Number.isFinite(reported)) return { cost: reported, source: 'reported' };
  if (!call.agent_version_id || !call.duration_s) return { cost: null, source: 'none' };
  const v = await dataService.one<{ stack_profile_id: string }>(
    `SELECT stack_profile_id FROM voice_agent.agent_version WHERE tenant_id = $1 AND version_id = $2`,
    [call.tenant_id, call.agent_version_id],
  );
  if (!v) return { cost: null, source: 'none' };
  const est = await estimateStackProfileCost(call.tenant_id, v.stack_profile_id).catch(() => null);
  if (!est) return { cost: null, source: 'none' };
  return { cost: Math.round(est.cost_per_min * (call.duration_s / 60) * 1e6) / 1e6, source: est.complete ? 'catalog_estimate' : 'catalog_estimate_partial' };
}

/** The ClickHouse row for a finished call. Exported for the unit test. */
export function callFactRow(call: CallDetail, cost: { cost: number | null; source: string }): Record<string, unknown> {
  const t = call.transcript ?? [];
  const agent = t.filter((x) => x.speaker === 'agent');
  const caller = t.filter((x) => x.speaker === 'caller');
  const tools = agent.flatMap((x) => (Array.isArray(x.tool_calls) ? x.tool_calls : []) as { ok?: boolean }[]);
  const degraded = (Array.isArray((call.context as { degraded?: unknown })?.degraded) ? (call.context as { degraded: { layer?: string; provider?: string }[] }).degraded : []);
  const ttfa = nums(agent.map((x) => x.ttfa_ms));
  const ended = call.ended_at ?? call.updated_at;
  const started = call.answered_at ?? call.started_at ?? call.created_at;
  return {
    call_id: call.call_id,
    tenant_id: call.tenant_id,
    agent_id: call.agent_id,
    agent_version_id: call.agent_version_id ?? '',
    direction: call.direction,
    is_test: call.is_test ? 1 : 0,
    status: call.status,
    disposition: call.disposition ?? '',
    started_at: ch(started),
    ended_at: ch(ended),
    duration_s: Math.max(0, Math.round(call.duration_s ?? (Date.parse(ended) - Date.parse(started)) / 1000) || 0),
    turns: t.length,
    agent_turns: agent.length,
    interrupted_turns: agent.filter((x) => x.interrupted).length,
    stt_ms_p50: pct(nums(caller.map((x) => x.stt_ms)), 0.5),
    ttft_ms_p50: pct(nums(agent.map((x) => x.ttft_ms)), 0.5),
    ttfa_ms_p50: pct(ttfa, 0.5),
    ttfa_ms_p95: pct(ttfa, 0.95),
    tool_calls: tools.length,
    tool_errors: tools.filter((x) => x.ok === false).length,
    provider_errors: degraded.length,
    degraded_layers: degraded.map((d) => String(d.layer ?? '')),
    degraded_providers: degraded.map((d) => String(d.provider ?? '')),
    cost_usd: cost.cost,
    cost_source: cost.source,
    version: Date.now(),
  };
}

/** onCallEnded listener: one call_facts row per finished call. Never throws. */
export async function recordCallFact(call: CallDetail): Promise<void> {
  try {
    await chInsert('voice.call_facts', [callFactRow(call, await callCost(call))]);
  } catch (err) {
    console.warn('[sdk-voice-agent] call fact not recorded', call.call_id, (err as Error).message);
  }
}

// ------------------------------------------------------------------------------ turn metrics

/** Consumes voice.turn.metrics.v1 into voice.turn_metrics (one consumer group per deployment). */
export async function startTurnMetricsConsumer(groupId = 'voice-analytics'): Promise<void> {
  // The runtime creates the topic on first publish; a consumer subscribing earlier (a fresh
  // cluster, gateway booting first) would fail and never retry — create it up front (idempotent).
  const admin = getKafka().admin();
  try {
    await admin.connect();
    await admin.createTopics({ topics: [{ topic: TURN_TOPIC, numPartitions: Number(process.env.VOICE_TURN_TOPIC_PARTITIONS ?? 6) }], waitForLeaders: true });
  } finally {
    await admin.disconnect().catch(() => undefined);
  }
  await createConsumer(groupId, [TURN_TOPIC], async ({ message }) => {
    if (!message.value) return;
    let e: Record<string, unknown>;
    try {
      e = JSON.parse(message.value.toString()) as Record<string, unknown>;
    } catch {
      return; // not ours / malformed: skip, never block the partition
    }
    const u = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? Math.max(0, Math.round(v)) : null);
    await chInsert('voice.turn_metrics', [{
      at: ch(typeof e.at === 'string' ? e.at : undefined),
      tenant_id: String(e.tenant_id ?? ''),
      call_id: String(e.call_id ?? ''),
      agent_id: String(e.agent_id ?? ''),
      agent_version_id: String(e.agent_version_id ?? ''),
      is_test: e.is_test ? 1 : 0,
      turn_index: u(e.turn_index) ?? 0,
      tier: String(e.tier ?? ''),
      model: String(e.model ?? ''),
      stt_ms: u(e.stt_ms),
      ttft_ms: u(e.ttft_ms),
      ttfa_ms: u(e.ttfa_ms),
      llm_ms: u(e.llm_ms) ?? 0,
      interrupted: e.interrupted ? 1 : 0,
      tool_calls: u(e.tool_calls) ?? 0,
      tool_errors: u(e.tool_errors) ?? 0,
      llm_failed: e.llm_failed ? 1 : 0,
      failed_over: Array.isArray(e.failed_over) ? e.failed_over.map(String) : [],
    }]);
  });
}

// ---------------------------------------------------------------------------------- queries

export interface AnalyticsFilter { from?: unknown; to?: unknown; agent_id?: unknown; include_tests?: unknown }

function window(f: AnalyticsFilter): { from: string; to: string; agentId: string | null; tests: 0 | 1 } {
  const to = f.to ? new Date(String(f.to)) : new Date();
  const from = f.from ? new Date(String(f.from)) : new Date(to.getTime() - 7 * 86_400_000);
  if (Number.isNaN(to.getTime()) || Number.isNaN(from.getTime())) throw validationError('from and to must be ISO timestamps');
  if (from >= to) throw validationError('from must be before to');
  if (to.getTime() - from.getTime() > 400 * 86_400_000) throw validationError('the window may span at most 400 days');
  const agentId = f.agent_id === undefined || f.agent_id === '' ? null : String(f.agent_id);
  if (agentId && !UUID_RE.test(agentId)) throw validationError('agent_id must be a uuid');
  return { from: ch(from), to: ch(to), agentId, tests: f.include_tests === 'true' || f.include_tests === true ? 1 : 0 };
}

/**
 * Per-stage latency, provider errors and cost per call for one tenant (or every tenant when
 * tenantId is null — operator view), over a window (default the last 7 days; test calls
 * excluded unless include_tests).
 */
export async function queryVoiceAnalytics(tenantId: string | null, f: AnalyticsFilter = {}) {
  const w = window(f);
  const params = { tenant: tenantId ?? '', from: w.from, to: w.to, agent: w.agentId ?? '', tests: w.tests };
  const where = `({tenant:String} = '' OR tenant_id = {tenant:String}) AND ({agent:String} = '' OR agent_id = {agent:String})
    AND (is_test = 0 OR {tests:UInt8} = 1)`;
  const [latency] = await chQuery<Record<string, number | null>>(
    `SELECT count() AS turns,
            quantileIf(0.5)(stt_ms, stt_ms IS NOT NULL)  AS stt_p50,  quantileIf(0.95)(stt_ms, stt_ms IS NOT NULL)  AS stt_p95,
            quantileIf(0.5)(ttft_ms, ttft_ms IS NOT NULL) AS ttft_p50, quantileIf(0.95)(ttft_ms, ttft_ms IS NOT NULL) AS ttft_p95,
            quantile(0.5)(llm_ms) AS llm_p50, quantile(0.95)(llm_ms) AS llm_p95,
            quantileIf(0.5)(ttfa_ms, ttfa_ms IS NOT NULL) AS ttfa_p50, quantileIf(0.95)(ttfa_ms, ttfa_ms IS NOT NULL) AS ttfa_p95,
            sum(llm_failed) AS llm_failures, sum(tool_errors) AS turn_tool_errors, sum(interrupted) AS interruptions
       FROM voice.turn_metrics WHERE ${where} AND at >= {from:DateTime64(3)} AND at < {to:DateTime64(3)}`,
    params,
  );
  const [calls] = await chQuery<Record<string, number | null>>(
    `SELECT count() AS calls, sum(duration_s) AS seconds, sum(provider_errors) AS failovers, sum(tool_errors) AS call_tool_errors,
            countIf(cost_usd IS NOT NULL) AS costed_calls, sum(cost_usd) AS total_cost, avg(cost_usd) AS avg_cost,
            quantile(0.95)(ttfa_ms_p95) AS ttfa_p95_of_calls
       FROM voice.call_facts FINAL WHERE ${where} AND ended_at >= {from:DateTime64(3)} AND ended_at < {to:DateTime64(3)}`,
    params,
  );
  const providerErrors = await chQuery<{ provider: string; layer: string; errors: number }>(
    `SELECT provider, layer, count() AS errors
       FROM voice.call_facts FINAL ARRAY JOIN degraded_providers AS provider, degraded_layers AS layer
      WHERE ${where} AND ended_at >= {from:DateTime64(3)} AND ended_at < {to:DateTime64(3)}
      GROUP BY provider, layer ORDER BY errors DESC LIMIT 50`,
    params,
  );
  const daily = await chQuery<Record<string, number | string | null>>(
    `SELECT toDate(ended_at) AS day, count() AS calls, sum(cost_usd) AS day_cost, sum(provider_errors) AS day_failovers,
            quantile(0.95)(ttfa_ms_p95) AS day_ttfa_p95
       FROM voice.call_facts FINAL WHERE ${where} AND ended_at >= {from:DateTime64(3)} AND ended_at < {to:DateTime64(3)}
      GROUP BY day ORDER BY day`,
    params,
  );
  const n = (v: unknown): number | null => (v === null || v === undefined || Number.isNaN(Number(v)) ? null : Math.round(Number(v) * 1e6) / 1e6);
  return {
    tenant_id: tenantId,
    window: { from: w.from, to: w.to, agent_id: w.agentId, include_tests: w.tests === 1 },
    latency_ms: {
      turns: n(latency?.turns) ?? 0,
      stt: { p50: n(latency?.stt_p50), p95: n(latency?.stt_p95) },
      ttft: { p50: n(latency?.ttft_p50), p95: n(latency?.ttft_p95) },
      llm: { p50: n(latency?.llm_p50), p95: n(latency?.llm_p95) },
      voice_to_voice: { p50: n(latency?.ttfa_p50), p95: n(latency?.ttfa_p95) },
    },
    errors: {
      provider_failovers: n(calls?.failovers) ?? 0,
      llm_failed_turns: n(latency?.llm_failures) ?? 0,
      tool_errors: n(latency?.turn_tool_errors) ?? 0,
      by_provider: providerErrors.map((r) => ({ provider: r.provider, layer: r.layer, errors: Number(r.errors) })),
    },
    cost: {
      calls: n(calls?.calls) ?? 0,
      minutes: calls?.seconds ? Math.round((Number(calls.seconds) / 60) * 100) / 100 : 0,
      costed_calls: n(calls?.costed_calls) ?? 0,
      total_usd: n(calls?.total_cost),
      per_call_usd: n(calls?.avg_cost),
      basis: 'reported by the runtime, else speech-catalog list price x duration (BYOK spend, not invoiced)',
    },
    daily: daily.map((d) => ({ day: String(d.day), calls: Number(d.calls), cost_usd: n(d.day_cost), provider_errors: Number(d.day_failovers), voice_to_voice_p95_ms: n(d.day_ttfa_p95) })),
  };
}

// ------------------------------------------------------------------------------ regressions

export interface RegressionConfig {
  /** Recent window judged. */
  windowMinutes: number;
  /** Trailing baseline, ending where the window starts. */
  baselineDays: number;
  /** Regression when window p95 > baseline p95 x (1 + pct). */
  thresholdPct: number;
  /** Too few turns in either window: no verdict. */
  minSamples: number;
}

export function regressionConfig(env: NodeJS.ProcessEnv = process.env): RegressionConfig {
  const n = (k: string, d: number): number => { const v = Number(env[k]); return Number.isFinite(v) && v > 0 ? v : d; };
  return {
    windowMinutes: n('VOICE_P95_WINDOW_MIN', 60),
    baselineDays: n('VOICE_P95_BASELINE_DAYS', 7),
    thresholdPct: n('VOICE_P95_REGRESSION_PCT', 25),
    minSamples: n('VOICE_P95_MIN_SAMPLES', 50),
  };
}

export interface RegressionVerdict { tenant_id: string; window_p95: number; baseline_p95: number; samples: number; regressed: boolean }

/** Pure verdict. Exported for the unit test. */
export function judgeRegression(r: { tenant_id: string; w_p95: number | null; w_n: number; b_p95: number | null; b_n: number }, cfg: RegressionConfig): RegressionVerdict | null {
  if (r.w_p95 === null || r.b_p95 === null || r.w_n < cfg.minSamples || r.b_n < cfg.minSamples || r.b_p95 <= 0) return null;
  return { tenant_id: r.tenant_id, window_p95: r.w_p95, baseline_p95: r.b_p95, samples: r.w_n, regressed: r.w_p95 > r.b_p95 * (1 + cfg.thresholdPct / 100) };
}

/**
 * Per tenant: last window's p95 voice-to-voice latency against its own trailing baseline.
 * A regression opens ONE sdk-incident per tenant (while an earlier one is still open, it is
 * not duplicated). Returns the verdicts it judged.
 */
export async function checkP95Regressions(cfg: RegressionConfig = regressionConfig()): Promise<RegressionVerdict[]> {
  const rows = await chQuery<{ tenant_id: string; w_p95: number | null; w_n: number; b_p95: number | null; b_n: number }>(
    `SELECT tenant_id,
            quantileIf(0.95)(ttfa_ms, at >= now64(3) - INTERVAL {w:UInt32} MINUTE) AS w_p95,
            countIf(at >= now64(3) - INTERVAL {w:UInt32} MINUTE) AS w_n,
            quantileIf(0.95)(ttfa_ms, at < now64(3) - INTERVAL {w:UInt32} MINUTE) AS b_p95,
            countIf(at < now64(3) - INTERVAL {w:UInt32} MINUTE) AS b_n
       FROM voice.turn_metrics
      WHERE is_test = 0 AND ttfa_ms IS NOT NULL AND at >= now64(3) - INTERVAL {w:UInt32} MINUTE - INTERVAL {b:UInt32} DAY
      GROUP BY tenant_id`,
    { w: cfg.windowMinutes, b: cfg.baselineDays },
  );
  const verdicts: RegressionVerdict[] = [];
  for (const r of rows) {
    const v = judgeRegression({ tenant_id: r.tenant_id, w_p95: r.w_p95 === null ? null : Number(r.w_p95), w_n: Number(r.w_n), b_p95: r.b_p95 === null ? null : Number(r.b_p95), b_n: Number(r.b_n) }, cfg);
    if (!v) continue;
    verdicts.push(v);
    if (!v.regressed || !UUID_RE.test(v.tenant_id)) continue;
    const open = (await listIncidents(v.tenant_id, { limit: 100 }))
      .filter((i) => i.incident_type === REGRESSION_INCIDENT_TYPE && !['resolved', 'closed', 'cancelled'].includes(String(i.status)));
    if (open.length > 0) continue;
    const pctUp = Math.round((v.window_p95 / v.baseline_p95 - 1) * 100);
    await createIncident({
      tenant_id: v.tenant_id,
      incident_type: REGRESSION_INCIDENT_TYPE,
      title: `Voice latency p95 up ${pctUp}%: ${Math.round(v.window_p95)} ms vs ${Math.round(v.baseline_p95)} ms baseline`,
      description: `Voice-to-voice p95 over the last ${cfg.windowMinutes} min (${v.samples} turns) is ${Math.round(v.window_p95)} ms against a ${cfg.baselineDays}-day baseline of ${Math.round(v.baseline_p95)} ms (threshold +${cfg.thresholdPct}%). Check provider failovers and per-stage latency in voice analytics.`,
      severity: pctUp >= 100 ? 'high' : 'medium',
      source: 'voice-analytics',
      subject_ref: `voice-tenant:${v.tenant_id}`,
      detected_at: new Date().toISOString(),
      metadata: { ...v, config: cfg },
    });
    console.warn('[sdk-voice-agent] p95 regression incident opened', v.tenant_id, v.window_p95, v.baseline_p95);
  }
  return verdicts;
}

/** Runs checkP95Regressions every `everyMs` (default 15 min). Returns a stop function. */
export function startP95RegressionJob(everyMs = Number(process.env.VOICE_P95_CHECK_MS ?? 15 * 60 * 1000)): () => void {
  const t = setInterval(() => {
    checkP95Regressions().catch((err: Error) => console.warn('[sdk-voice-agent] p95 regression check failed', err.message));
  }, everyMs);
  t.unref();
  return () => clearInterval(t);
}
