import { getPool } from '@projexlight/db-runtime';

/**
 * Local LLM latency probe (Y-P8-10 / AC-ONP-3).
 *
 * Periodically POSTs a sample completion to each ready local_llm_model
 * endpoint and records p50/p99 latency. When a model's p99 exceeds
 * AC-ONP-3 (3s for 1k tokens) for N consecutive probes, the probe flips
 * status to 'disabled' so the AI Gateway local-provider resolver stops
 * picking it.
 *
 * Probes use a small fixed prompt; production overrides via env
 * `ONPREM_PROBE_PROMPT`. Probe interval defaults to 5min; degradation
 * threshold defaults to 3 consecutive over-budget probes.
 */

export interface LocalLlmProbeConfig {
  enabled?: boolean;
  intervalMs?: number;
  /** Degradation threshold — consecutive over-budget probes before disable. */
  failureThreshold?: number;
  /** p99 budget per AC-ONP-3 — default 3000 ms. */
  p99BudgetMs?: number;
  /** Probe prompt (small). */
  prompt?: string;
}

export interface LocalLlmProbeHandle {
  stop(): Promise<void>;
  stats(): { ticks: number; probes_total: number; disabled_total: number; last_tick_at: string | null };
}

interface ModelRow {
  install_id: string;
  model_id: string;
  backend: string;
  endpoint_url: string;
}

async function listReadyModels(): Promise<ModelRow[]> {
  try {
    const pool = getPool();
    const { rows } = await pool.query<ModelRow>(
      `SELECT install_id, model_id, backend, endpoint_url
         FROM onprem.local_llm_model WHERE status = 'ready'`,
    );
    return rows;
  } catch {
    return [];
  }
}

async function probeOnce(model: ModelRow, prompt: string): Promise<number> {
  // Backend-specific URL shapes:
  //   - ollama: POST /api/generate { model, prompt, stream:false }
  //   - vllm  : POST /v1/completions { model, prompt, max_tokens }
  //   - tgi   : POST / { inputs: prompt }
  const url =
    model.backend === 'ollama' ? `${model.endpoint_url.replace(/\/$/, '')}/api/generate` :
    model.backend === 'vllm'   ? `${model.endpoint_url.replace(/\/$/, '')}/v1/completions` :
    `${model.endpoint_url.replace(/\/$/, '')}/`;
  const body =
    model.backend === 'ollama' ? { model: model.model_id, prompt, stream: false } :
    model.backend === 'vllm'   ? { model: model.model_id, prompt, max_tokens: 32 } :
    { inputs: prompt };

  const t0 = Date.now();
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(`probe ${res.status} ${res.statusText}`);
  }
  await res.json(); // drain body
  return Date.now() - t0;
}

async function disableModel(model: ModelRow, reason: string): Promise<void> {
  const pool = getPool();
  await pool.query(
    `UPDATE onprem.local_llm_model
        SET status = 'disabled'
      WHERE install_id = $1 AND model_id = $2`,
    [model.install_id, model.model_id],
  );
  console.warn(
    `[onprem:llm-probe] disabled ${model.install_id}/${model.model_id}: ${reason}`,
  );
}

export function startLocalLlmProbe(opts: LocalLlmProbeConfig = {}): LocalLlmProbeHandle {
  const cfg = {
    enabled: opts.enabled ?? true,
    intervalMs: opts.intervalMs ?? 5 * 60 * 1000,
    failureThreshold: opts.failureThreshold ?? 3,
    p99BudgetMs: opts.p99BudgetMs ?? 3000,
    prompt: opts.prompt ?? process.env.ONPREM_PROBE_PROMPT ?? 'Say hello.',
  };
  const stats = {
    ticks: 0,
    probes_total: 0,
    disabled_total: 0,
    last_tick_at: null as string | null,
  };
  // Per-(install, model) streak of over-budget probes.
  const overBudgetStreak = new Map<string, number>();
  let timer: ReturnType<typeof setInterval> | null = null;
  let stopped = false;

  function key(m: ModelRow): string { return `${m.install_id}:${m.model_id}`; }

  async function tick(): Promise<void> {
    if (stopped) return;
    stats.ticks += 1;
    stats.last_tick_at = new Date().toISOString();
    const models = await listReadyModels();
    for (const m of models) {
      try {
        const ms = await probeOnce(m, cfg.prompt);
        stats.probes_total += 1;
        if (ms > cfg.p99BudgetMs) {
          const s = (overBudgetStreak.get(key(m)) ?? 0) + 1;
          overBudgetStreak.set(key(m), s);
          if (s >= cfg.failureThreshold) {
            await disableModel(m, `p99 over budget: ${ms}ms > ${cfg.p99BudgetMs}ms for ${s} probes`);
            stats.disabled_total += 1;
            overBudgetStreak.delete(key(m));
          }
        } else {
          overBudgetStreak.delete(key(m));
        }
      } catch (err) {
        const s = (overBudgetStreak.get(key(m)) ?? 0) + 1;
        overBudgetStreak.set(key(m), s);
        if (s >= cfg.failureThreshold) {
          await disableModel(m, `probe error streak: ${(err as Error).message}`);
          stats.disabled_total += 1;
          overBudgetStreak.delete(key(m));
        }
      }
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
