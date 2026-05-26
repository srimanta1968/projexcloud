/**
 * Bridge from the hosted-MCP audit callback to sdk-meter's two-phase gate.
 *
 * Each CallTool invocation lands here; we map the tool name to a
 * registry-scoped SKU + call meter.report() with the tenant + actor
 * dimensions. report() is async-non-blocking — a metering failure
 * never blocks the MCP response.
 */

import type { AuditSink } from './mcpHandler';

export type MeterReporter = (input: {
  sku: string;
  units: number;
  dimensions: {
    org_id: string | null;
    app_id: string | null;
    tenant_id: string | null;
    bu_id: string | null;
    persona_id: string | null;
    encounter_id: string | null;
    pool_index: string;
    region: string;
    actor_kind: 'human' | 'service' | 'agent';
    actor_id: string;
    latency_ms?: number;
  };
}) => Promise<unknown>;

/**
 * Per-tool SKU mapping. Read tools meter as `registry.read.*`; future
 * write tools (scaffold, deploy) will meter under `registry.write.*`.
 * Tools without a mapping fall through to `registry.tool.other`.
 */
export const TOOL_SKU_MAP: Record<string, string> = {
  projex_registry_search_sdks: 'registry.read.search',
  projex_registry_get_manifest: 'registry.read.manifest',
  projex_registry_get_example: 'registry.read.example',
  projex_registry_list_compatible_sdks: 'registry.read.compatible',
  projex_registry_list_blueprints: 'registry.read.blueprints',
  projex_registry_get_blueprint: 'registry.read.blueprint',
  projex_registry_scaffold: 'registry.read.scaffold',
};

export function skuFor(toolName: string): string {
  return TOOL_SKU_MAP[toolName] ?? 'registry.tool.other';
}

export interface MeterSinkOptions {
  report: MeterReporter;
  pool_index: string;
  region: string;
}

/**
 * Build an AuditSink that fans into sdk-meter.report(). Caller is
 * responsible for providing the `report` function bound to whichever
 * pool / region the hosted MCP runs in.
 */
export function buildMeterSink(opts: MeterSinkOptions): AuditSink {
  return (event) => {
    const dims = {
      org_id: event.tenant.org_id,
      app_id: null,
      tenant_id: event.tenant.tenant_id,
      bu_id: null,
      persona_id: null,
      encounter_id: null,
      pool_index: opts.pool_index,
      region: opts.region,
      actor_kind: 'service' as const,
      actor_id: event.tenant.sub,
      latency_ms: event.duration_ms,
    };
    // Fire-and-forget; a metering failure must never block the MCP path.
    Promise.resolve(
      opts.report({ sku: skuFor(event.tool), units: 1, dimensions: dims }),
    ).catch((err) => {
      process.stderr.write(
        JSON.stringify({
          kind: 'registry-mcp.meter.failed',
          tool: event.tool,
          tenant: event.tenant.sub,
          error: (err as Error).message,
        }) + '\n',
      );
    });
  };
}

/** Compose multiple AuditSinks; useful for stdout-log + meter both. */
export function composeAuditSinks(...sinks: AuditSink[]): AuditSink {
  return (event) => {
    for (const s of sinks) {
      try { s(event); } catch (err) {
        process.stderr.write(
          JSON.stringify({ kind: 'registry-mcp.audit.sink.error', err: (err as Error).message }) + '\n',
        );
      }
    }
  };
}
