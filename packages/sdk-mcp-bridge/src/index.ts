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

// sdk-semantic stub (S-3) — TK-3322.
export { registerCapability, _resetSemanticStubWarning } from './services/semanticStub';
export type { CapabilityDescriptor, RegisterCapabilityResult } from './services/semanticStub';

// Transport abstraction (FR-MCP-4) — TK-3294.
export { openTransport } from './services/mcpTransport';
export type {
  McpTransport,
  TransportClient,
  McpToolDescriptor,
  OpenTransportInput,
  InvokeResult,
} from './services/mcpTransport';
