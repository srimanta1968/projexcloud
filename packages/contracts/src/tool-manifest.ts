/**
 * Tool manifest convention (G-6 / FR-ART-21..23).
 *
 * Every SDK that exports an agent-callable tool ships a manifest declaring:
 *   - tool_sku: the meter SKU charged on each call
 *   - display_name + description: surfaced in the tenant-admin UI
 *   - args_schema: JSON Schema the runtime validates against before mint
 *   - declared_skus_called: any downstream SKUs the tool invokes transitively
 *
 * At capability-token mint time, sdk-agent-runtime enforces
 * `declared_skus_called` ⊆ `agent_definition.tool_manifest` so an agent
 * cannot side-effect-call out-of-scope SKUs through a permissive tool.
 *
 * The registry is in-process (built at boot via registerToolManifest);
 * sdk-mcp-bridge tools auto-register their manifest from the external
 * server's tools/list response.
 */

import type { ToolManifest } from './p6a-agent';

const registry = new Map<string, ToolManifest>();

/**
 * Register a tool manifest. The SDK calling this is expected to be loaded
 * at api-gateway boot (alongside its server.registerRoutes call) so the
 * registry is populated before any agent run can mint a capability token.
 *
 * Duplicate registration with the same tool_sku replaces the previous
 * entry — useful for tests and hot-swap of MCP-discovered tools.
 */
export function registerToolManifest(manifest: ToolManifest): void {
  if (!manifest?.tool_sku) {
    throw new Error('[tool-manifest] tool_sku is required');
  }
  registry.set(manifest.tool_sku, manifest);
}

export function getToolManifest(tool_sku: string): ToolManifest | undefined {
  return registry.get(tool_sku);
}

export function listToolManifests(): ToolManifest[] {
  return Array.from(registry.values());
}

/**
 * Returns the set of SKUs that the given tool transitively calls.
 * Used by sdk-agent-runtime's scopeEnforcement to verify that the
 * agent's tool_manifest covers the tool's declared_skus_called too.
 */
export function declaredSkusCalled(tool_sku: string): string[] {
  const m = registry.get(tool_sku);
  return m?.declared_skus_called ?? [];
}

/** Test-only — clears the in-process registry. */
export function clearToolManifestRegistry(): void {
  registry.clear();
}
