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
import type { RegistryRef } from './catalogSource';

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

export interface BuildMcpServerOpts {
  tenant: TenantContext;
  audit?: AuditSink;
  /** Either pin one Registry for the session, or hand a ref so hot-reloads land mid-session. */
  registry?: Registry;
  registryRef?: RegistryRef;
}

export function buildMcpServer(opts: BuildMcpServerOpts): Server {
  if (!opts.registry && !opts.registryRef) {
    throw new Error('buildMcpServer requires either registry or registryRef');
  }
  const resolveRegistry = (): Registry =>
    opts.registryRef ? opts.registryRef.current : (opts.registry as Registry);

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
    const result = await dispatchTool(name, args ?? {}, resolveRegistry());
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
