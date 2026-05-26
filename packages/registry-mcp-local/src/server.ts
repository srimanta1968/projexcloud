/**
 * P9 / E3 — local registry MCP server (stdio).
 *
 * Speaks MCP wire protocol v1 over stdio so any MCP-aware AI client
 * (Claude Code, Cursor, Windsurf, Cline) can plug it in via their
 * mcp.json config.
 *
 * Read tools (FR-MCP-L2) are answered from the local catalog cache —
 * zero network. Write tools (FR-MCP-L4) are proxied to the hosted MCP
 * via the dev's stored API key; failures are queued locally and replayed
 * by `projex registry drain` (FR-MCP-L5).
 *
 * On startup, kicks a background daily refresh (FR-MCP-L3) and a
 * best-effort telemetry upload (FR-MCP-L6, off by default).
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { Registry } from '@projexlight/sdk-registry';
import { bootRegistry, ResolvedPaths } from './catalogLoader';
import { READ_TOOLS, dispatchTool, type ToolResult } from './tools';
import { WRITE_TOOLS, isWriteTool, proxyWriteTool, resolveProxySettings } from './writeProxy';
import { backgroundRefresh } from './autoRefresh';
import { bumpTool, maybeUploadDaily } from './telemetry';

const SERVER_NAME = 'projex-registry-mcp-local';
const SERVER_VERSION = '0.1.0';

export interface ServerInitOptions {
  /** Override monorepo root for the dev-fallback catalog lookup. */
  devRoot?: string;
  /** Pre-built registry for tests; if absent, bootRegistry resolves paths. */
  registry?: Registry;
  /** Skip the background refresh + telemetry upload (used by tests). */
  skipBackgroundTasks?: boolean;
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
    tools: [...READ_TOOLS, ...WRITE_TOOLS],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { name, arguments: args } = req.params;
    bumpTool(name); // FR-MCP-L6 — increments counters only when opted in

    if (isWriteTool(name)) {
      const settings = resolveProxySettings();
      if (!settings) {
        const result: ToolResult = {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                {
                  error:
                    'Write tools require a hosted MCP target. Run `projex login` (or set PROJEX_HOSTED_MCP + PROJEX_API_KEY) before using ' +
                    name +
                    '.',
                  code: 'NO_HOSTED_TARGET',
                },
                null,
                2,
              ),
            },
          ],
          isError: true,
        };
        return result as never;
      }
      const result = await proxyWriteTool(name, args ?? {}, settings);
      return result as never;
    }

    // dispatchTool returns a ToolResult { content, isError? } which is a
    // valid MCP ServerResult; the SDK's request handler return type is a
    // union including async-task envelopes we don't use, so we cast.
    return (await dispatchTool(name, args ?? {}, registry)) as never;
  });

  return { server, registry, paths };
}

/** Connect on stdio. Resolves when the transport closes. */
export async function runStdio(opts: ServerInitOptions = {}): Promise<void> {
  if (!opts.skipBackgroundTasks) {
    // Best-effort, non-blocking. Stderr-only logging keeps stdio clean.
    backgroundRefresh();
    void maybeUploadDaily();
  }
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
