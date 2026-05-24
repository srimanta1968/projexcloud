import { dataService } from '@projexlight/db-runtime';
import { appendAuditEntry } from '@projexlight/sdk-audit';

/**
 * agents.agent_definition CRUD (TK-3282, FR-ART-17..18).
 *
 * One row per logical agent. tenant_id null = platform agent. Every
 * mutation emits to the audit chain (regulated retention).
 */

const AGENT_AUDIT_POOL = process.env.AGENT_RUNTIME_AUDIT_POOL || 'admin-default';

export type AgentTier = 'sync' | 'orchestration' | 'batch';

export interface AgentDefinition {
  agent_id: string;
  tenant_id: string | null;
  name: string;
  description: string | null;
  acting_persona_id: string;
  agent_scope: unknown[];
  default_ttl_seconds: number;
  tier: AgentTier;
  kill_switch_flag_id: string | null;
  vector_namespace: string;
  tool_manifest: string[];
  created_by: string;
  created_at: Date;
  updated_at: Date;
}

export interface CreateAgentDefinitionInput {
  tenant_id: string | null;
  name: string;
  description?: string;
  acting_persona_id: string;
  agent_scope?: unknown[];
  default_ttl_seconds?: number;
  tier: AgentTier;
  kill_switch_flag_id?: string | null;
  vector_namespace: string;
  tool_manifest?: string[];
  created_by: string;
}

export async function createAgentDefinition(input: CreateAgentDefinitionInput): Promise<AgentDefinition> {
  const row = await dataService.one<AgentDefinition>(
    `INSERT INTO agents.agent_definition (
       tenant_id, name, description, acting_persona_id, agent_scope,
       default_ttl_seconds, tier, kill_switch_flag_id, vector_namespace,
       tool_manifest, created_by
     ) VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8, $9, $10::jsonb, $11)
     RETURNING agent_id, tenant_id::text, name, description, acting_persona_id,
               agent_scope, default_ttl_seconds, tier, kill_switch_flag_id,
               vector_namespace, tool_manifest, created_by, created_at, updated_at`,
    [
      input.tenant_id,
      input.name,
      input.description ?? null,
      input.acting_persona_id,
      JSON.stringify(input.agent_scope ?? []),
      input.default_ttl_seconds ?? 300,
      input.tier,
      input.kill_switch_flag_id ?? null,
      input.vector_namespace,
      JSON.stringify(input.tool_manifest ?? []),
      input.created_by,
    ],
  );
  if (!row) throw new Error('[agent-definition] insert failed');

  try {
    await appendAuditEntry({
      pool_index: AGENT_AUDIT_POOL,
      event_type: 'agent.run.started.v1',
      actor_kind: 'human',
      actor_id: input.created_by,
      tenant_id: input.tenant_id,
      subject_kind: 'agent.agent_definition',
      subject_id: row.agent_id,
      retention_class: 'regulated',
      payload: {
        kind: 'agent_definition.created',
        agent_id: row.agent_id,
        name: row.name,
        tier: row.tier,
        vector_namespace: row.vector_namespace,
      },
    });
  } catch (auditErr) {
    console.error('[agent-definition] audit emit failed', (auditErr as Error).message);
  }

  return row;
}

export async function getAgentDefinition(agent_id: string): Promise<AgentDefinition | null> {
  return dataService.one<AgentDefinition>(
    `SELECT agent_id, tenant_id::text, name, description, acting_persona_id,
            agent_scope, default_ttl_seconds, tier, kill_switch_flag_id,
            vector_namespace, tool_manifest, created_by, created_at, updated_at
       FROM agents.agent_definition WHERE agent_id = $1`,
    [agent_id],
  );
}

export interface ListAgentDefinitionsInput {
  tenant_id?: string | null;
  tier?: AgentTier;
  limit?: number;
  offset?: number;
}

export async function listAgentDefinitions(input: ListAgentDefinitionsInput): Promise<AgentDefinition[]> {
  const limit = Math.min(input.limit ?? 50, 200);
  const offset = input.offset ?? 0;
  const r = await dataService.query<AgentDefinition>(
    `SELECT agent_id, tenant_id::text, name, description, acting_persona_id,
            agent_scope, default_ttl_seconds, tier, kill_switch_flag_id,
            vector_namespace, tool_manifest, created_by, created_at, updated_at
       FROM agents.agent_definition
      WHERE ($1::uuid IS NULL OR tenant_id = $1::uuid)
        AND ($2::text IS NULL OR tier = $2)
      ORDER BY created_at DESC
      LIMIT $3 OFFSET $4`,
    [input.tenant_id ?? null, input.tier ?? null, limit, offset],
  );
  return r.rows;
}

/** Resolve the materialised agent_chain for a parent_run_id by walking
 *  parent links up to the root. Hard cap of 16 hops to prevent loops. */
export async function resolveAgentChain(parent_run_id: string | null): Promise<string[]> {
  if (!parent_run_id) return [];
  const r = await dataService.query<{ agent_chain: string[]; parent_run_id: string | null; agent_id: string }>(
    `WITH RECURSIVE chain AS (
       SELECT run_id, agent_id, parent_run_id, agent_chain, 1 AS depth
         FROM agents.agent_run WHERE run_id = $1
       UNION ALL
       SELECT r.run_id, r.agent_id, r.parent_run_id, r.agent_chain, c.depth + 1
         FROM agents.agent_run r
         JOIN chain c ON r.run_id = c.parent_run_id
        WHERE c.depth < 16
     )
     SELECT agent_id, parent_run_id, agent_chain FROM chain`,
    [parent_run_id],
  );
  // Build [oldest..newest agent_id]
  return r.rows.map((row) => row.agent_id).reverse();
}
