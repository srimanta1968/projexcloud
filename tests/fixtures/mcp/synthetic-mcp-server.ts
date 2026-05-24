/**
 * Synthetic MCP test server (I-4 / TK-3306).
 *
 * Three lightweight HTTP servers stand in for real Slack / Snowflake /
 * Jira MCP servers in CI. Each implements just enough of the MCP HTTP
 * protocol that sdk-mcp-bridge's registration + invocation paths can
 * exercise the full code path:
 *
 *   POST /tools/list   → { tools: McpToolDescriptor[] }
 *   POST /tools/call   → { content, isError?, external_cost? }
 *   GET  /health       → { status: 'ok', server: <name> }
 *
 * Authorization header is checked but the bearer value is the literal
 * "test-token" — the suite seeds that exact credential when registering.
 *
 * Used by:
 *   - packages/sdk-mcp-bridge/tests/chaos/ac-12-three-mcp-orchestration.test.ts
 *   - docker-compose.test.yml maps ports 7081 (slack), 7082 (snowflake),
 *     7083 (jira) so the test suite can reach the fixtures consistently.
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'http';

const TEST_TOKEN = 'test-token';

interface SyntheticTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  /** Returns the synthetic call result (content + optional external_cost). */
  handler: (args: unknown) => { content: unknown; external_cost?: number };
}

export interface FixtureConfig {
  name: 'slack-mcp-fixture' | 'snowflake-mcp-fixture' | 'jira-mcp-fixture';
  port: number;
  tools: SyntheticTool[];
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function send(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(body));
}

function unauthorized(res: ServerResponse): void {
  send(res, 401, { error: 'unauthorized' });
}

export function startFixture(config: FixtureConfig): { stop: () => Promise<void> } {
  const server = createServer(async (req, res) => {
    try {
      if (req.method === 'GET' && req.url === '/health') {
        return send(res, 200, { status: 'ok', server: config.name });
      }
      const auth = req.headers.authorization;
      if (auth !== `Bearer ${TEST_TOKEN}`) return unauthorized(res);

      if (req.method === 'POST' && req.url === '/tools/list') {
        return send(res, 200, {
          tools: config.tools.map((t) => ({
            name: t.name,
            description: t.description,
            inputSchema: t.inputSchema,
          })),
        });
      }
      if (req.method === 'POST' && req.url === '/tools/call') {
        const raw = await readBody(req);
        const body = JSON.parse(raw || '{}') as { name?: string; arguments?: unknown };
        const tool = config.tools.find((t) => t.name === body.name);
        if (!tool) return send(res, 404, { content: null, isError: true, error: 'unknown_tool' });
        try {
          const result = tool.handler(body.arguments);
          return send(res, 200, { content: result.content, external_cost: result.external_cost });
        } catch (toolErr) {
          return send(res, 500, { content: null, isError: true, error: (toolErr as Error).message });
        }
      }
      return send(res, 404, { error: 'not_found' });
    } catch (err) {
      return send(res, 500, { error: (err as Error).message });
    }
  });
  server.listen(config.port, '0.0.0.0');
  return {
    stop: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
}

export const SLACK_FIXTURE: FixtureConfig = {
  name: 'slack-mcp-fixture',
  port: parseInt(process.env.MCP_FIXTURE_SLACK_PORT || '7081', 10),
  tools: [
    {
      name: 'post-message',
      description: 'Post a message to a Slack channel (synthetic).',
      inputSchema: { type: 'object', properties: { channel: { type: 'string' }, text: { type: 'string' } } },
      handler: (args) => ({
        content: { ok: true, ts: `${Date.now() / 1000}`, channel: (args as { channel?: string })?.channel },
        external_cost: 0,
      }),
    },
  ],
};

export const SNOWFLAKE_FIXTURE: FixtureConfig = {
  name: 'snowflake-mcp-fixture',
  port: parseInt(process.env.MCP_FIXTURE_SNOWFLAKE_PORT || '7082', 10),
  tools: [
    {
      name: 'query',
      description: 'Run a SQL query against the synthetic warehouse.',
      inputSchema: { type: 'object', properties: { sql: { type: 'string' } } },
      handler: (args) => ({
        content: { rows: [{ count: 42 }], statement_id: `synth-${Date.now()}`, sql: (args as { sql?: string })?.sql },
        external_cost: 0.0001,
      }),
    },
  ],
};

export const JIRA_FIXTURE: FixtureConfig = {
  name: 'jira-mcp-fixture',
  port: parseInt(process.env.MCP_FIXTURE_JIRA_PORT || '7083', 10),
  tools: [
    {
      name: 'create-issue',
      description: 'Create a Jira issue (synthetic).',
      inputSchema: { type: 'object', properties: { project: { type: 'string' }, title: { type: 'string' } } },
      handler: (args) => ({
        content: {
          key: `${(args as { project?: string })?.project ?? 'TEST'}-${Math.floor(Math.random() * 1000)}`,
          self: `https://synthetic.local/issues/`,
        },
        external_cost: 0,
      }),
    },
  ],
};

/**
 * Start all three fixtures. Used by docker-compose entrypoint and by
 * the test harness's beforeAll when the docker compose isn't up.
 */
export function startAllFixtures(): { stop: () => Promise<void> } {
  const slack = startFixture(SLACK_FIXTURE);
  const snowflake = startFixture(SNOWFLAKE_FIXTURE);
  const jira = startFixture(JIRA_FIXTURE);
  return {
    stop: async () => {
      await Promise.all([slack.stop(), snowflake.stop(), jira.stop()]);
    },
  };
}

// When invoked directly (node synthetic-mcp-server.js) start all three.
if (require.main === module) {
  const handle = startAllFixtures();
  console.log(
    `[mcp-fixtures] slack:${SLACK_FIXTURE.port} snowflake:${SNOWFLAKE_FIXTURE.port} jira:${JIRA_FIXTURE.port}`,
  );
  const shutdown = async (): Promise<void> => {
    await handle.stop();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
