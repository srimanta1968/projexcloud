/**
 * Wires the MCP Server for one SSE session. Reuses the READ_TOOLS +
 * dispatchTool from @projexlight/registry-mcp-local so behavior matches
 * the local stdio MCP byte-for-byte. The hosted variant adds a per-call
 * audit hook so tenant-scoped usage can be metered.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import type { Registry } from '@projexlight/sdk-registry';
import { READ_TOOLS, dispatchTool } from '@projexlight/registry-mcp-local/dist/tools';
import type { TenantContext } from './auth';

const SERVER_NAME = 'projex-registry-mcp-hosted';
const SERVER_VERSION = '0.1.0';

export interface AuditSink {
  (event: {
    tenant: TenantContext;
    tool: string;
    ok: boolean;
    duration_ms: number;
  }): void;
}

export function buildMcpServer(opts: {
  registry: Registry;
  tenant: TenantContext;
  audit?: AuditSink;
}): Server {
  const server = new Server(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: READ_TOOLS,
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { name, arguments: args } = req.params;
    const startedAt = Date.now();
    const result = await dispatchTool(name, args ?? {}, opts.registry);
    opts.audit?.({
      tenant: opts.tenant,
      tool: name,
      ok: !result.isError,
      duration_ms: Date.now() - startedAt,
    });
    return result as never;
  });

  return server;
}
