/**
 * N-2 perf bench — capability-token mint ≤ 5ms p99 (PRD §6).
 *
 * Mints 10,000 capability tokens (HMAC sign + insert into
 * agents.capability_token + audit emit). Asserts p99 ≤ 5ms.
 *
 * Run: pnpm --filter @projexlight/sdk-agent-runtime test:perf
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { initPool, dataService } from '../../packages/db-runtime/src';
import {
  mintToken,
  createAgentDefinition,
  startAgentRun,
} from '../../packages/sdk-agent-runtime/src';

const ITERATIONS = parseInt(process.env.N2_ITERATIONS ?? '10000', 10);
const BUDGET_P99_MS = parseInt(process.env.N2_BUDGET_P99_MS ?? '5', 10);

function p99(samples: number[]): number {
  const sorted = [...samples].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.99))];
}

describe('N-2 · capability-token mint latency', () => {
  let agent_id: string;
  let run_id: string;
  const acting_persona_id = '00000000-0000-4000-9000-00000000n201';

  beforeAll(async () => {
    if (!process.env.DB_HOST) return;
    initPool({
      host: process.env.DB_HOST,
      port: parseInt(process.env.DB_PORT ?? '5432', 10),
      database: process.env.DB_NAME ?? 'projexcloud_db',
      user: process.env.DB_USER ?? 'postgres',
      password: process.env.DB_PASSWORD ?? 'postgres',
    });
    const def = await createAgentDefinition({
      tenant_id: null,
      name: 'n2-perf-agent',
      acting_persona_id,
      tier: 'sync',
      default_ttl_seconds: 300,
      vector_namespace: 'vector_n2_perf',
      tool_manifest: ['crm.contact.create'],
      created_by: 'n2-perf',
    });
    agent_id = def.agent_id;
    const run = await startAgentRun({
      agent_id,
      persona_id: acting_persona_id,
      trace_id: 'n2-perf',
      actor_id: 'n2-perf',
      actor_kind: 'service',
    });
    run_id = run.run_id;
  }, 30_000);

  it(`p99 mint ≤ ${BUDGET_P99_MS}ms over ${ITERATIONS} mints`, async () => {
    if (!process.env.DB_HOST) {
      console.warn('[N-2] skipping — DB_HOST not set');
      return;
    }
    const latencies: number[] = [];
    for (let i = 0; i < ITERATIONS; i += 1) {
      const t0 = process.hrtime.bigint();
      await mintToken({
        run_id,
        agent_id,
        acting_persona_id,
        tool_sku: 'crm.contact.create',
        args: { i },
        tenant_scope: 'platform',
        ttl_seconds: 60,
      });
      latencies.push(Number(process.hrtime.bigint() - t0) / 1_000_000);
    }
    const p99Lat = p99(latencies);
    console.log(`[N-2] p99=${p99Lat.toFixed(2)}ms (budget ${BUDGET_P99_MS}ms)`);
    // Clean up the minted rows so the suite doesn't bloat capability_token.
    await dataService.query(`DELETE FROM agents.capability_token WHERE run_id = $1`, [run_id]);
    expect(p99Lat).toBeLessThanOrEqual(BUDGET_P99_MS);
  });
});
