#!/usr/bin/env node
/**
 * P9 / E3 — `projex-registry-mcp-local` bin entry.
 *
 * Boots the MCP server on stdio. Wire it into your AI tool's mcp.json:
 *
 *   {
 *     "mcpServers": {
 *       "projex-registry": {
 *         "command": "projex-registry-mcp-local"
 *       }
 *     }
 *   }
 *
 * Or via npx without install:
 *
 *   {
 *     "mcpServers": {
 *       "projex-registry": {
 *         "command": "npx",
 *         "args": ["-y", "@projexlight/registry-mcp-local"]
 *       }
 *     }
 *   }
 *
 * Env vars:
 *   PROJEX_CATALOG_PATH   Explicit catalog path. Overrides the default
 *                         lookup (~/.projex/cache/registry.catalog.json).
 *   PROJEX_DEV_ROOT       Monorepo root for dev-fallback (used in this
 *                         workspace's package.json scripts).
 */

import { runStdio } from './server';

const devRoot = process.env.PROJEX_DEV_ROOT;

runStdio({ devRoot }).catch((err) => {
  process.stderr.write(`[projex-registry-mcp-local] fatal: ${(err && err.stack) || err}\n`);
  process.exit(1);
});
