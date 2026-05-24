/**
 * sdk-semantic stub interface (S-3 / FR-MCP-2).
 *
 * sdk-semantic (the Enterprise Semantic Model Layer) is P6B; sdk-mcp-bridge
 * calls into it at tool auto-discovery time to register each MCP tool in
 * the CapabilityGraph. Until P6B lands, this module provides a no-op
 * implementation matching the eventual signature so sdk-mcp-bridge can
 * call `registerCapability(...)` without a dynamic import or conditional
 * branch.
 *
 * P6B ships sdk-semantic with a runtime registry that replaces this
 * module via package.json `imports`/`exports` swap (no code change in
 * sdk-mcp-bridge).
 */

export interface CapabilityDescriptor {
  tool_sku: string;
  tool_name: string;
  args_schema: Record<string, unknown>;
  source: 'internal' | 'mcp' | 'connector';
  tenant_id: string | null;
  /** Free-form tags the future semantic layer uses to group capabilities. */
  domain_tags?: string[];
}

export interface RegisterCapabilityResult {
  /** True when sdk-semantic accepted + persisted the descriptor. */
  registered: boolean;
  /** Filled in once P6B sdk-semantic is online; today it's the local synthetic id. */
  capability_id: string;
  /** When true, the runtime is the v0 stub — caller should expect no graph queries. */
  is_stub: true;
}

/**
 * Register a tool in the CapabilityGraph (stub). Logs once on first call
 * so deployments can confirm sdk-semantic is not yet wired. Always
 * returns a synthesised id so callers behave identically pre/post-P6B.
 */
let warned = false;
export function registerCapability(descriptor: CapabilityDescriptor): RegisterCapabilityResult {
  if (!warned) {
    // eslint-disable-next-line no-console
    console.warn(
      '[sdk-mcp-bridge] CapabilityGraph stub active — sdk-semantic not yet online (P6B). Tools are registered for runtime use but cross-domain inference is unavailable.',
    );
    warned = true;
  }
  const capability_id = `stub:${descriptor.source}:${descriptor.tool_sku}`;
  return { registered: true, capability_id, is_stub: true };
}

/** Test/dev — resets the one-shot warning. */
export function _resetSemanticStubWarning(): void {
  warned = false;
}
