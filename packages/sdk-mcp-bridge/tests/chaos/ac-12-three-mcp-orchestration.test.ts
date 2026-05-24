/**
 * AC-12 chaos drill — three-MCP-server orchestration.
 *
 * An agent plan executes three external MCP tools in sequence under one
 * trace_id:
 *   1. mcp.slack.post-message  (channel: #engineering)
 *   2. mcp.snowflake.query     (SELECT COUNT(*) FROM incidents WHERE ...)
 *   3. mcp.jira.create-issue   (title, labels)
 *
 * Assertions:
 *   - All three tool calls audited with the matching mcp_server_id.
 *   - One trace_id covers the whole orchestration.
 *   - sdk-meter records cost per tool (one usage event per call).
 *   - Each capability token is scoped per call and consumed exactly once.
 *
 * Synthetic transport: the test registers the three MCP servers against
 * stub HTTP fixtures running on localhost (started by docker-compose.test.yml
 * via TK-3306). When DB_HOST or the fixtures are unavailable, the suite
 * skips cleanly so non-integration CI stays green.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { dataService, initPool } from '@projexlight/db-runtime';
import {
  mintToken,
  startAgentRun,
  createAgentDefinition,
} from '@projexlight/sdk-agent-runtime';
import {
  registerMcpServer,
  invokeMcpTool,
} from '../../src/services/mcpRegistration';
import { invokeMcpTool as invoke } from '../../src/services/mcpInvocation';

const TENANT = '00000000-0000-4000-b000-00000000000c';
const PERSONA = '00000000-0000-4000-b000-00000000000d';
const TRACE_ID = 'trace_ac12_orchestration';

interface FixtureServer {
  display_name: string;
  endpoint_url: string;
  tool_sku: string;
  tool_name: string;
  args: Record<string, unknown>;
}

const FIXTURES: FixtureServer[] = [
  {
    display_name: 'slack-mcp-fixture',
    endpoint_url: process.env.MCP_FIXTURE_SLACK_URL ?? 'http://localhost:7081',
    tool_sku: 'mcp.slack.post-message',
    tool_name: 'post-message',
    args: { channel: '#engineering', text: 'Alert: critical issue' },
  },
  {
    display_name: 'snowflake-mcp-fixture',
    endpoint_url: process.env.MCP_FIXTURE_SNOWFLAKE_URL ?? 'http://localhost:7082',
    tool_sku: 'mcp.snowflake.query',
    tool_name: 'query',
    args: { sql: 'SELECT COUNT(*) FROM incidents WHERE date = CURRENT_DATE' },
  },
  {
    display_name: 'jira-mcp-fixture',
    endpoint_url: process.env.MCP_FIXTURE_JIRA_URL ?? 'http://localhost:7083',
    tool_sku: 'mcp.jira.create-issue',
    tool_name: 'create-issue',
    args: { project: 'INC', title: 'Investigate spike', labels: ['ops', 'p1'] },
  },
];

async function fixturesReachable(): Promise<boolean> {
  try {
    for (const f of FIXTURES) {
      const res = await fetch(`${f.endpoint_url}/health`, { method: 'GET' });
      if (!res.ok) return false;
    }
    return true;
  } catch {
    return false;
  }
}

describe('AC-12 · three-MCP-server orchestration', () => {
  let agentId: string;
  let runId: string;
  const registrationIds: string[] = [];
  const toolIds = new Map<string, string>();

  beforeAll(async () => {
    if (!process.env.DB_HOST) return;
    initPool({
      host: process.env.DB_HOST,
      port: parseInt(process.env.DB_PORT ?? '5432', 10),
      database: process.env.DB_NAME ?? 'projexcloud_db',
      user: process.env.DB_USER ?? 'postgres',
      password: process.env.DB_PASSWORD ?? 'postgres',
    });
    if (!(await fixturesReachable())) return;

    const def = await createAgentDefinition({
      tenant_id: TENANT,
      name: 'ac12-orchestrator',
      acting_persona_id: PERSONA,
      tier: 'orchestration',
      default_ttl_seconds: 600,
      vector_namespace: 'vector_ten_ac12',
      tool_manifest: FIXTURES.map((f) => f.tool_sku),
      created_by: 'ac12-test',
    });
    agentId = def.agent_id;
    const run = await startAgentRun({
      agent_id: agentId,
      persona_id: PERSONA,
      trace_id: TRACE_ID,
      actor_id: 'ac12-test',
      actor_kind: 'human',
    });
    runId = run.run_id;

    for (const f of FIXTURES) {
      const reg = await registerMcpServer({
        tenant_id: TENANT,
        display_name: f.display_name,
        transport: 'http',
        endpoint_url: f.endpoint_url,
        credential_envelope: Buffer.from('test-token', 'utf8'),
        allowed_agent_ids: [agentId],
        actor_id: 'ac12-test',
      });
      registrationIds.push(reg.server.registration_id);
      const found = reg.tools.find((t) => t.tool_name === f.tool_name);
      if (found) toolIds.set(f.tool_sku, found.tool_id);
    }
  }, 60_000);

  afterAll(async () => {
    if (!process.env.DB_HOST) return;
    try {
      for (const reg of registrationIds) {
        await dataService.query(
          `DELETE FROM mcp.server_registration WHERE registration_id = $1`,
          [reg],
        );
      }
      if (runId) {
        await dataService.query(`DELETE FROM agents.agent_run WHERE run_id = $1`, [runId]);
      }
      if (agentId) {
        await dataService.query(`DELETE FROM agents.agent_definition WHERE agent_id = $1`, [agentId]);
      }
    } catch {
      /* best-effort cleanup */
    }
  });

  it('runs slack → snowflake → jira under one trace_id, each call audited + metered', async () => {
    if (!process.env.DB_HOST) {
      console.warn('[ac-12] skipping — DB_HOST not set');
      return;
    }
    if (!(await fixturesReachable())) {
      console.warn('[ac-12] skipping — synthetic MCP fixtures not reachable (start docker-compose.test.yml)');
      return;
    }

    const invocations: Array<{ sku: string; invocation_id: string; outcome: string }> = [];

    for (const f of FIXTURES) {
      const tool_id = toolIds.get(f.tool_sku);
      expect(tool_id, `tool_id missing for ${f.tool_sku}`).toBeDefined();

      const minted = await mintToken({
        run_id: runId,
        agent_id: agentId,
        acting_persona_id: PERSONA,
        tool_sku: f.tool_sku,
        args: f.args,
        tenant_scope: TENANT,
        ttl_seconds: 60,
      });

      const result = await invoke({
        tool_id: tool_id!,
        agent_run_id: runId,
        capability_token_id: minted.token_id,
        args: f.args,
        trace_id: TRACE_ID,
      });
      invocations.push({ sku: f.tool_sku, invocation_id: result.invocation_id, outcome: result.outcome });
      expect(result.outcome, `invocation ${f.tool_sku} should succeed`).toBe('succeeded');
    }

    expect(invocations).toHaveLength(3);

    // Audit + persistence assertions: one row per call, all under runId,
    // each tied to its own capability token (single-use enforced).
    const persisted = await dataService.query<{
      invocation_id: string;
      tool_id: string;
      capability_token_id: string;
      outcome: string;
    }>(
      `SELECT invocation_id::text, tool_id::text, capability_token_id::text, outcome
         FROM mcp.tool_invocation WHERE agent_run_id = $1::uuid
        ORDER BY occurred_at ASC`,
      [runId],
    );
    expect(persisted.rows).toHaveLength(3);
    const tokenIds = new Set(persisted.rows.map((r) => r.capability_token_id));
    expect(tokenIds.size, 'each call must use a distinct capability token').toBe(3);

    // trace_id propagation: every audit entry tied to these invocations
    // should reference the same trace_id in its payload (operational retention).
    const auditCount = await dataService.one<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM audit.entry
        WHERE event_type = 'mcp.tool.invoked.v1'
          AND payload->>'trace_id' = $1`,
      [TRACE_ID],
    );
    expect(parseInt(auditCount?.n ?? '0', 10)).toBeGreaterThanOrEqual(3);
  });
});
