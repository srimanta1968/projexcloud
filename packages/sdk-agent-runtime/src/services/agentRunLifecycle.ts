import { dataService } from '@projexlight/db-runtime';
import { appendAuditEntry } from '@projexlight/sdk-audit';
import { getAgentDefinition, resolveAgentChain } from './agentDefinitionService';

/**
 * agents.agent_run lifecycle (TK-3283).
 *
 * startRun computes ttl_deadline from the agent's default_ttl_seconds
 * (capped by per-tenant overrides — future hook), materialises the
 * agent_chain by walking parent_run_id, opens the vector-namespace
 * handle (via the namespace registry — verification already happened
 * at boot), and emits agent.run.started.v1 with the chain as actor
 * provenance (FR-ART-17..18).
 */

const AGENT_AUDIT_POOL = process.env.AGENT_RUNTIME_AUDIT_POOL || 'admin-default';

export type AgentRunStatus =
  | 'running'
  | 'completed'
  | 'failed'
  | 'terminated_ttl_expired'
  | 'terminated_kill_switch'
  | 'terminated_quota';

export interface AgentRun {
  run_id: string;
  agent_id: string;
  tenant_id: string | null;
  persona_id: string;
  trace_id: string;
  parent_run_id: string | null;
  agent_chain: string[];
  status: AgentRunStatus;
  ttl_deadline: Date;
  started_at: Date;
  ended_at: Date | null;
  tokens_total: number;
  cost_total: string;
  execution_log_ref: string | null;
}

export interface StartRunInput {
  agent_id: string;
  persona_id: string;
  trace_id: string;
  parent_run_id?: string;
  /** Override the agent's default_ttl_seconds; capped at 3600. */
  ttl_seconds?: number;
  /** Caller for audit attribution (the human or meta-agent triggering the run). */
  actor_id: string;
  actor_kind: 'human' | 'service' | 'agent';
}

export async function startAgentRun(input: StartRunInput): Promise<AgentRun> {
  const agent = await getAgentDefinition(input.agent_id);
  if (!agent) {
    throw new Error(`[agent-run] agent_definition ${input.agent_id} not found`);
  }

  const ttl = Math.min(input.ttl_seconds ?? agent.default_ttl_seconds, 3600);
  if (ttl <= 0) throw new Error('[agent-run] ttl_seconds must be > 0');

  const startedAt = new Date();
  const ttlDeadline = new Date(startedAt.getTime() + ttl * 1000);

  // Materialise the agent_chain from the parent run, then append THIS agent.
  const parentChain = await resolveAgentChain(input.parent_run_id ?? null);
  const agentChain = [...parentChain, input.actor_id, input.agent_id];

  const row = await dataService.one<AgentRun>(
    `INSERT INTO agents.agent_run (
       agent_id, tenant_id, persona_id, trace_id, parent_run_id,
       agent_chain, status, ttl_deadline, started_at
     ) VALUES ($1, $2::uuid, $3, $4, $5::uuid, $6, 'running', $7, $8)
     RETURNING run_id, agent_id, tenant_id::text, persona_id, trace_id,
               parent_run_id, agent_chain, status, ttl_deadline, started_at,
               ended_at, tokens_total, cost_total, execution_log_ref`,
    [
      input.agent_id,
      agent.tenant_id,
      input.persona_id,
      input.trace_id,
      input.parent_run_id ?? null,
      agentChain,
      ttlDeadline,
      startedAt,
    ],
  );
  if (!row) throw new Error('[agent-run] insert failed');

  try {
    await appendAuditEntry({
      pool_index: AGENT_AUDIT_POOL,
      event_type: 'agent.run.started.v1',
      actor_kind: input.actor_kind,
      actor_id: input.actor_id,
      tenant_id: agent.tenant_id,
      subject_kind: 'agent.agent_run',
      subject_id: row.run_id,
      retention_class: 'regulated',
      payload: {
        agent_id: row.agent_id,
        persona_id: row.persona_id,
        trace_id: row.trace_id,
        parent_run_id: row.parent_run_id,
        agent_chain: row.agent_chain,
        ttl_deadline: ttlDeadline.toISOString(),
      },
    });
  } catch (auditErr) {
    console.error('[agent-run] audit emit failed', row.run_id, (auditErr as Error).message);
  }

  return row;
}

export async function getAgentRun(run_id: string): Promise<AgentRun | null> {
  return dataService.one<AgentRun>(
    `SELECT run_id, agent_id, tenant_id::text, persona_id, trace_id,
            parent_run_id, agent_chain, status, ttl_deadline, started_at,
            ended_at, tokens_total, cost_total, execution_log_ref
       FROM agents.agent_run WHERE run_id = $1`,
    [run_id],
  );
}

export interface ListRunsInput {
  tenant_id?: string | null;
  agent_id?: string;
  status?: AgentRunStatus;
  limit?: number;
  offset?: number;
}

export async function listAgentRuns(input: ListRunsInput): Promise<AgentRun[]> {
  const limit = Math.min(input.limit ?? 50, 200);
  const offset = input.offset ?? 0;
  const r = await dataService.query<AgentRun>(
    `SELECT run_id, agent_id, tenant_id::text, persona_id, trace_id,
            parent_run_id, agent_chain, status, ttl_deadline, started_at,
            ended_at, tokens_total, cost_total, execution_log_ref
       FROM agents.agent_run
      WHERE ($1::uuid IS NULL OR tenant_id = $1::uuid)
        AND ($2::uuid IS NULL OR agent_id = $2::uuid)
        AND ($3::text IS NULL OR status = $3)
      ORDER BY started_at DESC
      LIMIT $4 OFFSET $5`,
    [input.tenant_id ?? null, input.agent_id ?? null, input.status ?? null, limit, offset],
  );
  return r.rows;
}
