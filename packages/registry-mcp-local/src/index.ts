/**
 * @projexlight/registry-mcp-local — P9 / E3 Phase 1
 *
 * Public surface for embedders (tests, future hosted MCP reuse, custom
 * launchers). The actual entry point most consumers want is the
 * `projex-registry-mcp-local` bin script, which boots a stdio server
 * with sensible defaults.
 */

export { initializeServer, runStdio, type InitializedServer, type ServerInitOptions } from './server';
export { READ_TOOLS, dispatchTool, type ToolDefinition, type ToolResult } from './tools';
export { bootRegistry, resolveCatalogPaths, type ResolvedPaths } from './catalogLoader';
