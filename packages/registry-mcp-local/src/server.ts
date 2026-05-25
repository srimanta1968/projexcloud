/**
 * P9 / E3 Phase 1 — local registry MCP server (stdio).
 *
 * Speaks MCP wire protocol v1 over stdio so any MCP-aware AI client
 * (Claude Code, Cursor, Windsurf, Cline) can plug it in via their
 * mcp.json config. Phase 1 exposes the READ tool surface answered
 * entirely from the local catalog cache — no network required.
 *
 * Write tools (scaffold, deploy) land in Phase 2 by proxying to the
 * hosted services/registry-mcp using the tenant's stored API key.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { Registry } from '@projexlight/sdk-registry';
import { bootRegistry, ResolvedPaths } from './catalogLoader';
import { READ_TOOLS, dispatchTool } from './tools';

const SERVER_NAME = 'projex-registry-mcp-local';
const SERVER_VERSION = '0.1.0';

export interface ServerInitOptions {
  /** Override monorepo root for the dev-fallback catalog lookup. */
  devRoot?: string;
  /** Pre-built registry for tests; if absent, bootRegistry resolves paths. */
  registry?: Registry;
}

export interface InitializedServer {
  server: Server;
  registry: Registry;
  paths: ResolvedPaths | null;
}

/**
 * Wires the MCP Server with both ListTools + CallTool request handlers
 * backed by the local Registry. Does NOT connect a transport; caller
 * decides stdio (production) vs. test harness.
 */
export async function initializeServer(opts: ServerInitOptions = {}): Promise<InitializedServer> {
  let registry: Registry;
  let paths: ResolvedPaths | null = null;
  if (opts.registry) {
    registry = opts.registry;
  } else {
    const booted = await bootRegistry(opts.devRoot);
    registry = booted.registry;
    paths = booted.paths;
  }

  const server = new Server(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: READ_TOOLS,
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { name, arguments: args } = req.params;
    // dispatchTool returns a ToolResult { content, isError? } which is a
    // valid MCP ServerResult; the SDK's request handler return type is a
    // union including async-task envelopes we don't use, so we cast.
    return (await dispatchTool(name, args ?? {}, registry)) as never;
  });

  return { server, registry, paths };
}

/** Connect on stdio. Resolves when the transport closes. */
export async function runStdio(opts: ServerInitOptions = {}): Promise<void> {
  const { server, paths } = await initializeServer(opts);
  if (paths) {
    process.stderr.write(
      `[projex-registry-mcp-local] catalog source=${paths.source}, path=${paths.catalogPath}\n` +
        `[projex-registry-mcp-local] embeddings=${paths.embeddingPaths ? 'loaded' : 'absent (substring fallback)'}\n`,
    );
  }
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
