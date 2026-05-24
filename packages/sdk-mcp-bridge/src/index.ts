/**
 * @projexlight/sdk-mcp-bridge — public surface.
 *
 * P6A. Bidirectional Model Context Protocol. Consume external MCP servers
 * per tenant; expose selected ProjexCloud SDKs as MCP servers. Capability-
 * token gated, meter-billed, audit-logged exactly like internal tools.
 * v0 surface (scaffold): migrationsDir only; register + invoke + expose
 * endpoints land in TK-3293/3294/3295.
 */
export { migrationsDir } from './db';
export * as server from './server';

// MCP server registration + tool auto-discovery (FR-MCP-1, FR-MCP-2) — TK-3294.
export {
  registerMcpServer,
  getMcpServer,
  listMcpServers,
  disableMcpServer,
} from './services/mcpRegistration';
export type {
  RegisterMcpServerInput,
  RegisterResult,
  RegisteredServer,
} from './services/mcpRegistration';

// MCP tool invocation (FR-MCP-3 / AC-12) — TK-3295.
export { invokeMcpTool } from './services/mcpInvocation';
export type { InvokeMcpToolInput, InvokeMcpToolResult } from './services/mcpInvocation';

// sdk-semantic CapabilityGraph wiring (FR-SEM-9 / TK-3381). Each MCP tool
// is registered into semantic.capability_graph_edge on server-register and
// soft-deprecated on server-disable. Re-exported here for callers that
// want to register tools manually (e.g. bypassing transport probe).
export {
  registerMcpCapability,
  deprecateMcpCapabilities,
} from '@projexlight/sdk-semantic';
export type {
  RegisterMcpCapabilityInput,
  RegisterMcpCapabilityResult,
} from '@projexlight/sdk-semantic';

// Transport abstraction (FR-MCP-4) — TK-3294.
export { openTransport } from './services/mcpTransport';
export type {
  McpTransport,
  TransportClient,
  McpToolDescriptor,
  OpenTransportInput,
  InvokeResult,
} from './services/mcpTransport';
