import { randomUUID } from 'crypto';
import { dataService } from '@projexlight/db-runtime';

/**
 * MCP → CapabilityGraph auto-registration (FR-SEM-9 + G-9 wiring).
 *
 * Every tool exposed by an external MCP server registered via sdk-mcp-bridge
 * appears in semantic.capability_graph_edge so sdk-semantic.plan() can
 * propose plans that include MCP tool steps.
 *
 * Design:
 *   - All MCP tools attach to a built-in ontology `platform-mcp-v1` with a
 *     single generic object_type `ExternalMcpTool`. Tenants that want to
 *     pin specific MCP tools to a domain subject (e.g. an MCP "create
 *     Encounter" tool bound to the Healthcare Patient subject) override
 *     by passing `subject_object_type_id` explicitly.
 *   - Re-registering the same (object_type_id, tool_sku) updates the
 *     pre/post conditions and reactivates a deprecated row.
 *   - Disable flips status='deprecated' rather than hard-deleting so the
 *     audit/lineage trail survives.
 */

const PLATFORM_MCP_ONTOLOGY_NAME = 'platform-mcp-v1';
const PLATFORM_MCP_ONTOLOGY_VERSION = '1.0.0';
const PLATFORM_MCP_OBJECT_TYPE = 'ExternalMcpTool';

interface OntologyRow {
  ontology_id: string;
}

interface ObjectTypeRow {
  object_type_id: string;
}

interface EdgeRow {
  edge_id: string;
  object_type_id: string;
  tool_sku: string;
  status: string;
}

/**
 * Ensure the built-in `platform-mcp-v1` ontology + `ExternalMcpTool`
 * object_type exist. Idempotent — returns the existing rows after the
 * first call.
 */
async function ensurePlatformMcpOntology(): Promise<{ ontology_id: string; object_type_id: string }> {
  const ontology = await dataService.one<OntologyRow>(
    `INSERT INTO semantic.ontology
       (ontology_id, name, version, status, bundle_ref)
     VALUES ($1, $2, $3, 'active', 'builtin:platform-mcp')
     ON CONFLICT (name, version) DO UPDATE SET status = EXCLUDED.status
     RETURNING ontology_id`,
    [randomUUID(), PLATFORM_MCP_ONTOLOGY_NAME, PLATFORM_MCP_ONTOLOGY_VERSION],
  );
  if (!ontology) throw new Error('[mcp-capability] failed to ensure platform-mcp ontology');

  const objectType = await dataService.one<ObjectTypeRow>(
    `INSERT INTO semantic.object_type
       (object_type_id, ontology_id, name, attribute_schema, backed_by)
     VALUES ($1, $2, $3, $4::jsonb, $5)
     ON CONFLICT (ontology_id, name) DO UPDATE SET backed_by = EXCLUDED.backed_by
     RETURNING object_type_id`,
    [
      randomUUID(),
      ontology.ontology_id,
      PLATFORM_MCP_OBJECT_TYPE,
      JSON.stringify({ type: 'object', properties: { tool_name: { type: 'string' } } }),
      'mcp.tool:external',
    ],
  );
  if (!objectType) throw new Error('[mcp-capability] failed to ensure ExternalMcpTool object_type');

  return { ontology_id: ontology.ontology_id, object_type_id: objectType.object_type_id };
}

export interface RegisterMcpCapabilityInput {
  /** SKU used by sdk-meter — e.g. mcp.slack.post-message. */
  tool_sku: string;
  /** Source MCP tool id (for audit trail). */
  mcp_tool_id: string;
  /** JSON schema of args (becomes pre_conditions). */
  args_schema: Record<string, unknown>;
  /** Optional response shape (becomes post_conditions). */
  response_schema?: Record<string, unknown>;
  /** Override the default ExternalMcpTool subject when the tenant pins this
   *  tool to a domain object_type (e.g. Patient for a Healthcare-specific
   *  MCP tool). */
  subject_object_type_id?: string;
}

export interface RegisterMcpCapabilityResult {
  edge_id: string;
  object_type_id: string;
  tool_sku: string;
  status: 'active';
}

/**
 * Register (or re-activate) a capability_graph_edge for an MCP tool. Safe
 * to call multiple times for the same (object_type_id, tool_sku) pair.
 */
export async function registerMcpCapability(
  input: RegisterMcpCapabilityInput,
): Promise<RegisterMcpCapabilityResult> {
  const objectTypeId = input.subject_object_type_id
    ?? (await ensurePlatformMcpOntology()).object_type_id;

  const row = await dataService.one<EdgeRow>(
    `INSERT INTO semantic.capability_graph_edge
       (edge_id, object_type_id, tool_sku, pre_conditions, post_conditions, status)
     VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, 'active')
     ON CONFLICT (object_type_id, tool_sku) DO UPDATE
       SET pre_conditions = EXCLUDED.pre_conditions,
           post_conditions = EXCLUDED.post_conditions,
           status = 'active'
     RETURNING edge_id, object_type_id, tool_sku, status`,
    [
      randomUUID(),
      objectTypeId,
      input.tool_sku,
      JSON.stringify(input.args_schema ?? {}),
      JSON.stringify(input.response_schema ?? {}),
    ],
  );
  if (!row) throw new Error(`[mcp-capability] insert failed for ${input.tool_sku}`);
  return { edge_id: row.edge_id, object_type_id: row.object_type_id, tool_sku: row.tool_sku, status: 'active' };
}

/**
 * Mark every capability edge for the given list of tool SKUs as deprecated.
 * Used when an MCP server is disabled — soft-delete preserves history.
 * Returns the count of rows affected.
 */
export async function deprecateMcpCapabilities(tool_skus: string[]): Promise<number> {
  if (tool_skus.length === 0) return 0;
  const r = await dataService.query(
    `UPDATE semantic.capability_graph_edge
        SET status = 'deprecated'
      WHERE tool_sku = ANY($1)
        AND status = 'active'`,
    [tool_skus],
  );
  return r.rowCount ?? 0;
}
