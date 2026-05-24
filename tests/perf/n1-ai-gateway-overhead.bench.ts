/**
 * N-1 perf bench — AI Gateway latency overhead ≤ 10ms p99 (PRD §6).
 *
 * Runs 10,000 sdk-ai-gateway.complete() calls through a stub provider
 * that returns a fixed-latency response. Subtracts the stub's known
 * latency from the wall-clock per call → that's the gateway overhead.
 *
 * Pass condition: p99 overhead ≤ 10ms.
 *
 * Run: pnpm --filter @projexlight/sdk-ai-gateway test:perf
 * CI: invoked from .github/workflows/perf.yml; fails the build on regression.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  registerProvider,
  clearProviderRegistry,
  complete,
  type ProviderAdapter,
  type ProviderCompletionResult,
} from '../../packages/sdk-ai-gateway/src';
import type { AgentContext, CompletionRequest } from '../../packages/contracts/src';

const ITERATIONS = parseInt(process.env.N1_ITERATIONS ?? '10000', 10);
const STUB_LATENCY_MS = 5;
const OVERHEAD_BUDGET_P99_MS = parseInt(process.env.N1_BUDGET_P99_MS ?? '10', 10);

const fixedAnthropic: ProviderAdapter = {
  provider_id: 'anthropic',
  async complete(): Promise<ProviderCompletionResult> {
    await new Promise((r) => setTimeout(r, STUB_LATENCY_MS));
    return {
      output: 'ok',
      tool_calls: [],
      tokens_in: 1,
      tokens_out: 1,
      provider_cost: 0,
      finish_reason: 'stop',
    };
  },
  async *stream() {
    /* not exercised by N-1 */
  },
};

function p99(samples: number[]): number {
  const sorted = [...samples].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.floor(sorted.length * 0.99));
  return sorted[idx];
}

describe('N-1 · AI Gateway latency overhead', () => {
  beforeAll(() => {
    clearProviderRegistry();
    registerProvider(fixedAnthropic);
  });
  afterAll(() => clearProviderRegistry());

  it(`p99 overhead ≤ ${OVERHEAD_BUDGET_P99_MS}ms over ${ITERATIONS} calls`, async () => {
    if (!process.env.DB_HOST) {
      console.warn('[N-1] skipping — DB_HOST not set');
      return;
    }
    const ctx: AgentContext = {
      agent_id: '00000000-0000-4000-8000-00000000n001',
      run_id: '00000000-0000-4000-8000-00000000n002',
      acting_persona_id: '00000000-0000-4000-8000-00000000n003',
      tenant_id: null,
      trace_id: 'n1-perf',
      ttl_deadline: new Date(Date.now() + 60_000).toISOString(),
      agent_chain: [],
    };
    const req: CompletionRequest = { model: 'claude-opus-4-7', prompt: 'x', provider_hint: 'anthropic' };

    const overheads: number[] = [];
    for (let i = 0; i < ITERATIONS; i += 1) {
      const t0 = process.hrtime.bigint();
      await complete(req, ctx);
      const wall = Number(process.hrtime.bigint() - t0) / 1_000_000;
      overheads.push(wall - STUB_LATENCY_MS);
    }
    const p99Overhead = p99(overheads);
    console.log(`[N-1] p99=${p99Overhead.toFixed(2)}ms (budget ${OVERHEAD_BUDGET_P99_MS}ms)`);
    expect(p99Overhead).toBeLessThanOrEqual(OVERHEAD_BUDGET_P99_MS);
  });
});
