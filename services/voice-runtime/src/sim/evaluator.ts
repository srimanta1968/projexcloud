import type { Bootstrap, ControlPlane, EvalRunJob } from '../controlPlane';
import { log } from '../log';
import type { SessionStore, TurnRecord } from '../session/sessionStore';
import { runScenario, type ScenarioResult } from './scenarioRunner';

/**
 * Runs one evaluation run end to end (VA·E10 · TK-4518): for each scenario the control plane
 * opens a test call, the runtime bootstraps it exactly like a real call (agent version, stack,
 * keys, tools, session token), plays the scenario, writes the call's transcript, and finally
 * scores the run and reports it.
 *
 * Run-level thresholds (evaluation mode; a sandbox run is not judged on latency — its model
 * is a script):
 *   VOICE_EVAL_MAX_TTFT_P95_MS  p95 time to first LLM token across the run (default 1500)
 */

const MAX_TTFT_P95_MS = Number(process.env.VOICE_EVAL_MAX_TTFT_P95_MS ?? 1500);

export interface EvaluatorDeps {
  controlPlane: ControlPlane;
  store: SessionStore;
  worker: string;
}

function percentile(values: number[], p: number): number | null {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.ceil(s.length * p) - 1))];
}

function p95(values: number[]): number | null {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.ceil(s.length * 0.95) - 1)];
}

/**
 * Refuses anything that is not a test call the control plane opened for THIS run — the guard
 * that keeps fake providers and scripted agents off real calls, whatever the database says.
 */
export function assertEvalCall(boot: Bootstrap, job: EvalRunJob): void {
  const ctx = boot.call.context ?? {};
  if (!boot.call.is_test || ctx.eval_run_id !== job.eval_run_id) throw new Error('refusing to simulate a call that is not a test call of this evaluation run');
  if (job.mode === 'sandbox' && ctx.sandbox !== true) throw new Error('refusing sandbox providers on a call not marked sandbox');
  if (boot.call.tenant_id !== job.tenant_id || boot.agent.version_id !== job.version_id) throw new Error('the evaluation call does not belong to this run');
}

export async function runEvaluation(job: EvalRunJob, deps: EvaluatorDeps): Promise<void> {
  const { controlPlane, worker } = deps;
  const results: ScenarioResult[] = [];
  log.info('evaluation run started', { evalRunId: job.eval_run_id, mode: job.mode, scenarios: job.scenarios.length });
  try {
    for (let i = 0; i < job.scenarios.length; i++) {
      const scenario = job.scenarios[i];
      const { call_id } = await controlPlane.createEvalCall(job.eval_run_id, worker, i);
      let result: ScenarioResult;
      let records: TurnRecord[] = [];
      try {
        const boot = await controlPlane.bootstrap({ call_id });
        if (boot.action !== 'agent') throw new Error(`bootstrap answered ${boot.action}`);
        assertEvalCall(boot, job);
        ({ result, records } = await runScenario({ boot, scenario, mode: job.mode, controlPlane, store: deps.store }));
      } catch (err) {
        result = {
          name: scenario.name, call_id, passed: false, checks: [], error: (err as Error).message, turns: 0, tools: [],
          transfer_requested: false, ttft_ms: [], barge_in_stop_ms: [], transcript: [], duration_ms: 0,
        };
      }
      results.push(result);
      // The scenario's call, like any call, ends with its transcript written (test call: never billed).
      await controlPlane.completeCall(call_id, {
        status: result.error ? 'failed' : 'completed',
        turns: records,
        started_at: new Date(Date.now() - result.duration_ms).toISOString(),
        ended_at: new Date().toISOString(),
        duration_s: Math.round(result.duration_ms / 1000),
      }).catch((err: Error) => log.warn('could not close out an evaluation call', { callId: call_id, error: err.message }));
    }

    const ttft = results.flatMap((r) => r.ttft_ms);
    const ttftP95 = p95(ttft);
    const runChecks = job.mode === 'evaluation'
      ? [{ name: 'ttft_p95', passed: ttftP95 !== null && ttftP95 <= MAX_TTFT_P95_MS, detail: `p95 ${ttftP95 ?? 'n/a'} ms (limit ${MAX_TTFT_P95_MS})` }]
      : [];
    const all = [...results.flatMap((r) => r.checks), ...runChecks];
    const passed = results.every((r) => r.passed) && runChecks.every((c) => c.passed);
    const score = all.length ? all.filter((c) => c.passed).length / all.length : 0;
    const bargeIns = results.flatMap((r) => r.barge_in_stop_ms);
    const tools = results.flatMap((r) => r.tools);
    await controlPlane.finishEvalRun(job.eval_run_id, {
      worker,
      status: 'completed',
      passed,
      score: Math.round(score * 10000) / 10000,
      metrics: {
        scenarios: results.length,
        scenarios_passed: results.filter((r) => r.passed).length,
        ttft_p50_ms: percentile(ttft, 0.5),
        ttft_p95_ms: ttftP95,
        barge_in_max_stop_ms: bargeIns.length ? Math.max(...bargeIns) : null,
        tool_calls: tools.length,
        tool_errors: tools.filter((t) => !t.ok).length,
        run_checks: runChecks,
        thresholds: { ttft_p95_ms: job.mode === 'evaluation' ? MAX_TTFT_P95_MS : null, barge_in_stop_ms: Number(process.env.VOICE_EVAL_MAX_BARGE_IN_MS ?? 250) },
      },
      results,
    });
    log.info('evaluation run finished', { evalRunId: job.eval_run_id, passed, score });
  } catch (err) {
    log.error('evaluation run could not complete', { evalRunId: job.eval_run_id, error: (err as Error).message });
    await controlPlane.finishEvalRun(job.eval_run_id, { worker, status: 'error', error: (err as Error).message, results })
      .catch((e: Error) => log.error('could not report the evaluation error', { evalRunId: job.eval_run_id, error: e.message }));
  }
}

/**
 * Polls for queued runs and runs them one at a time (VOICE_EVAL_ENABLED=false turns it off;
 * VOICE_EVAL_POLL_MS sets the interval). Stops taking new runs on drain.
 */
export class EvalWorker {
  private stopped = false;
  private current: Promise<void> | null = null;
  private timer: NodeJS.Timeout | null = null;

  constructor(private readonly deps: EvaluatorDeps, private readonly pollMs = Number(process.env.VOICE_EVAL_POLL_MS ?? 3000)) {}

  start(): void {
    if (process.env.VOICE_EVAL_ENABLED === 'false') {
      log.info('evaluation runs disabled on this worker (VOICE_EVAL_ENABLED=false)');
      return;
    }
    this.schedule(this.pollMs);
  }

  private schedule(ms: number): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => void this.tick(), ms);
    this.timer.unref();
  }

  private async tick(): Promise<void> {
    if (this.stopped) return;
    let job: EvalRunJob | null = null;
    try {
      job = (await this.deps.controlPlane.claimEvalRun(this.deps.worker)).eval_run;
    } catch (err) {
      log.warn('could not poll for evaluation runs', { error: (err as Error).message });
    }
    if (job) {
      this.current = runEvaluation(job, this.deps).finally(() => { this.current = null; });
      await this.current;
      this.schedule(0);
    } else {
      this.schedule(this.pollMs);
    }
  }

  /** No new runs; resolves when the one in progress (if any) has finished. */
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    await this.current;
  }
}
