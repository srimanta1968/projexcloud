/**
 * N-3 perf bench — MCP tool invocation overhead ≤ 50ms p99 (PRD §6).
 *
 * Invokes the synthetic Slack-MCP stub (started by TK-3306 fixtures)
 * 10,000 times via sdk-mcp-bridge.invokeMcpTool. Subtracts the stub's
 * known sub-millisecond HTTP RTT from the wall-clock per call → that's
 * the bridge overhead (capability-token validate + audit emit +
 * transport encode/decode).
 *
 * Run: pnpm --filter @projexlight/sdk-mcp-bridge test:perf
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { initPool, dataService } from '../../packages/db-runtime/src';
import {
  registerMcpServer,
  invokeMcpTool,
} from '../../packages/sdk-mcp-bridge/src';
import {
  createAgentDefinition,
  startAgentRun,
  mintToken,
} from '../../packages/sdk-agent-runtime/src';

const ITERATIONS = parseInt(process.env.N3_ITERATIONS ?? '10000', 10);
const BUDGET_P99_MS = parseInt(process.env.N3_BUDGET_P99_MS ?? '50', 10);
const FIXTURE_URL = process.env.MCP_FIXTURE_SLACK_URL ?? 'http://localhost:7081';

function p99(samples: number[]): number {
  const sorted = [...samples].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.99))];
}

describe('N-3 · MCP tool invocation overhead', () => {
  const tenant_id = '00000000-0000-4000-9000-00000000n301';
  let registration_id: string;
  let tool_id: string;
  let agent_id: string;
  let run_id: string;
  const persona = '00000000-0000-4000-9000-00000000n302';

  beforeAll(async () => {
    if (!process.env.DB_HOST) return;
    initPool({
      host: process.env.DB_HOST,
      port: parseInt(process.env.DB_PORT ?? '5432', 10),
      database: process.env.DB_NAME ?? 'projexcloud_db',
      user: process.env.DB_USER ?? 'postgres',
      password: process.env.DB_PASSWORD ?? 'postgres',
    });
    try {
      const probe = await fetch(`${FIXTURE_URL}/health`);
      if (!probe.ok) throw new Error('not ok');
    } catch {
      return;
    }
    const def = await createAgentDefinition({
      tenant_id,
      name: 'n3-perf-agent',
      acting_persona_id: persona,
      tier: 'orchestration',
      vector_namespace: 'vector_n3_perf',
      tool_manifest: ['mcp.slack.post-message'],
      created_by: 'n3-perf',
    });
    agent_id = def.agent_id;
    const run = await startAgentRun({
      agent_id,
      persona_id: persona,
      trace_id: 'n3-perf',
      actor_id: 'n3-perf',
      actor_kind: 'service',
    });
    run_id = run.run_id;
    const reg = await registerMcpServer({
      tenant_id,
      display_name: 'n3-perf-slack',
      transport: 'http',
      endpoint_url: FIXTURE_URL,
      credential_envelope: Buffer.from('test-token', 'utf8'),
      allowed_agent_ids: [agent_id],
      actor_id: 'n3-perf',
    });
    registration_id = reg.server.registration_id;
    const t = reg.tools.find((x) => x.tool_name === 'post-message');
    if (!t) throw new Error('[N-3] post-message tool not auto-discovered');
    tool_id = t.tool_id;
  }, 30_000);

  afterAll(async () => {
    if (!process.env.DB_HOST) return;
    try {
      if (registration_id) {
        await dataService.query(`DELETE FROM mcp.server_registration WHERE registration_id = $1`, [registration_id]);
      }
      if (run_id) await dataService.query(`DELETE FROM agents.agent_run WHERE run_id = $1`, [run_id]);
      if (agent_id) await dataService.query(`DELETE FROM agents.agent_definition WHERE agent_id = $1`, [agent_id]);
    } catch {
      /* best-effort */
    }
  });

  it(`p99 invoke overhead ≤ ${BUDGET_P99_MS}ms over ${ITERATIONS} calls`, async () => {
    if (!process.env.DB_HOST) {
      console.warn('[N-3] skipping — DB_HOST not set');
      return;
    }
    if (!tool_id) {
      console.warn('[N-3] skipping — fixture not reachable');
      return;
    }
    // Measure baseline RTT to the fixture so we can subtract it.
    const baseSamples: number[] = [];
    for (let i = 0; i < 100; i += 1) {
      const t0 = process.hrtime.bigint();
      await fetch(`${FIXTURE_URL}/health`);
      baseSamples.push(Number(process.hrtime.bigint() - t0) / 1_000_000);
    }
    const baselineP99 = p99(baseSamples);

    const overheads: number[] = [];
    for (let i = 0; i < ITERATIONS; i += 1) {
      const minted = await mintToken({
        run_id,
        agent_id,
        acting_persona_id: persona,
        tool_sku: 'mcp.slack.post-message',
        args: { i },
        tenant_scope: tenant_id,
        ttl_seconds: 60,
      });
      const t0 = process.hrtime.bigint();
      await invokeMcpTool({
        tool_id,
        agent_run_id: run_id,
        capability_token_id: minted.token_id,
        args: { i },
        trace_id: 'n3-perf',
      });
      const wall = Number(process.hrtime.bigint() - t0) / 1_000_000;
      overheads.push(Math.max(0, wall - baselineP99));
    }
    const overheadP99 = p99(overheads);
    console.log(
      `[N-3] p99 overhead=${overheadP99.toFixed(2)}ms (budget ${BUDGET_P99_MS}ms, baseline RTT p99=${baselineP99.toFixed(2)}ms)`,
    );
    expect(overheadP99).toBeLessThanOrEqual(BUDGET_P99_MS);
  });
});
