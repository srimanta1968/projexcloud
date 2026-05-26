/**
 * @projexlight/registry-mcp-local — P9 / E3
 *
 * Public surface for embedders (tests, future hosted MCP reuse, custom
 * launchers). The actual entry point most consumers want is the
 * `projex-registry-mcp-local` bin script, which boots a stdio server
 * with sensible defaults.
 */

export { initializeServer, runStdio, type InitializedServer, type ServerInitOptions } from './server';
export { READ_TOOLS, dispatchTool, type ToolDefinition, type ToolResult } from './tools';
export { bootRegistry, resolveCatalogPaths, type ResolvedPaths } from './catalogLoader';
export {
  WRITE_TOOLS,
  isWriteTool,
  proxyWriteTool,
  resolveProxySettings,
  drainQueue,
  readQueue,
  rewriteQueue,
  type ProxySettings,
  type QueueEntry,
} from './writeProxy';
export {
  maybeRefreshCatalog,
  backgroundRefresh,
  type RefreshOptions,
  type RefreshResult,
} from './autoRefresh';
export {
  isTelemetryEnabled,
  setTelemetry,
  bumpTool,
  maybeUploadDaily,
  type UploadResult,
} from './telemetry';
