import { dataService } from '@projexlight/db-runtime';
import { appendAuditEntry } from '@projexlight/sdk-audit';
import { submitRequest } from '@projexlight/sdk-approval';

/**
 * Tool-manifest enforcement + scope-exception routing (FR-ART-21..23 / AC-7, AC-9).
 *
 * Every agent_definition declares a `tool_manifest` array of SKUs it's
 * allowed to call. The capability-token issuer calls this enforcement
 * function BEFORE the database insert so an out-of-manifest mint is
 * denied at admission, not after the fact (FR-ART-23).
 *
 * On a violation:
 *   1. Insert an agents.scope_exception row tracking the requested_sku.
 *   2. Try to route the exception through sdk-approval — looks up an
 *      active approval.route whose kind_pattern matches
 *      'agent.scope_exception' for the agent's tenant. When no route is
 *      configured, the exception is recorded but no approval is created
 *      (the caller can still see it via the audit + scope_exception
 *      table).
 *   3. Emit agent.scope.exceeded.v1 (regulated retention).
 *   4. Throw ScopeViolationError so the caller surfaces a clean error.
 *
 * The capability-token issuer catches ScopeViolationError and returns
 * the matching reason to the REST surface, which produces a 403.
 */

const AGENT_AUDIT_POOL = process.env.AGENT_RUNTIME_AUDIT_POOL || 'admin-default';
const SCOPE_EXCEPTION_ROUTE_KIND = 'agent.scope_exception';

export class ScopeViolationError extends Error {
  readonly code = 'ScopeViolation';
  readonly requested_sku: string;
  readonly agent_id: string;
  readonly exception_id: string;
  readonly approval_request_id: string | null;
  constructor(input: {
    message: string;
    requested_sku: string;
    agent_id: string;
    exception_id: string;
    approval_request_id: string | null;
  }) {
    super(input.message);
    this.name = 'ScopeViolationError';
    this.requested_sku = input.requested_sku;
    this.agent_id = input.agent_id;
    this.exception_id = input.exception_id;
    this.approval_request_id = input.approval_request_id;
  }
}

interface AgentDefinitionRow {
  agent_id: string;
  tenant_id: string | null;
  tool_manifest: string[];
}

async function loadAgentDefinition(agent_id: string): Promise<AgentDefinitionRow | null> {
  // tool_manifest is JSONB on disk but conceptually an array of SKU strings.
  // pg returns JSONB as parsed JS — we typecast and validate.
  const row = await dataService.one<{
    agent_id: string;
    tenant_id: string | null;
    tool_manifest: unknown;
  }>(
    `SELECT agent_id, tenant_id::text, tool_manifest
       FROM agents.agent_definition WHERE agent_id = $1`,
    [agent_id],
  );
  if (!row) return null;
  const manifest = Array.isArray(row.tool_manifest)
    ? (row.tool_manifest as unknown[]).filter((s): s is string => typeof s === 'string')
    : [];
  return { agent_id: row.agent_id, tenant_id: row.tenant_id, tool_manifest: manifest };
}

async function findScopeExceptionRoute(tenant_id: string | null): Promise<string | null> {
  if (!tenant_id) return null;
  const row = await dataService.one<{ route_id: string }>(
    `SELECT route_id FROM approval.route
      WHERE tenant_id = $1
        AND kind_pattern = $2
        AND status = 'active'
      ORDER BY created_at DESC
      LIMIT 1`,
    [tenant_id, SCOPE_EXCEPTION_ROUTE_KIND],
  );
  return row?.route_id ?? null;
}

export interface EnforceInput {
  agent_id: string;
  run_id: string;
  acting_persona_id: string;
  requested_sku: string;
}

export interface EnforceResult {
  decision: 'allow';
}

/**
 * Validates the requested SKU against the agent's tool_manifest.
 * Returns `{decision: 'allow'}` on success; throws `ScopeViolationError`
 * on a manifest miss (with the scope_exception + approval_request ids
 * attached to the error so the caller can surface them).
 */
export async function enforceToolManifest(input: EnforceInput): Promise<EnforceResult> {
  const agent = await loadAgentDefinition(input.agent_id);
  if (!agent) {
    throw new Error(`[scope-enforcement] agent_definition ${input.agent_id} not found`);
  }
  if (agent.tool_manifest.includes(input.requested_sku)) {
    return { decision: 'allow' };
  }

  // Out of manifest — record the exception, route through approval, audit.
  const exceptionRow = await dataService.one<{ exception_id: string }>(
    `INSERT INTO agents.scope_exception (run_id, requested_sku, outcome)
     VALUES ($1, $2, 'pending')
     RETURNING exception_id`,
    [input.run_id, input.requested_sku],
  );
  if (!exceptionRow) {
    throw new Error('[scope-enforcement] failed to record scope_exception');
  }

  let approval_request_id: string | null = null;
  const routeId = await findScopeExceptionRoute(agent.tenant_id);
  if (routeId && agent.tenant_id) {
    try {
      const result = await submitRequest({
        tenant_id: agent.tenant_id,
        route_id: routeId,
        subject_kind: 'agent.scope_exception',
        subject_id: exceptionRow.exception_id,
        initiator_persona_id: input.acting_persona_id,
        reason: `Agent ${input.agent_id} requested out-of-scope tool ${input.requested_sku}`,
      });
      approval_request_id = result.request.request_id;
      await dataService.query(
        `UPDATE agents.scope_exception
            SET approval_request_id = $2
          WHERE exception_id = $1`,
        [exceptionRow.exception_id, approval_request_id],
      );
    } catch (approvalErr) {
      // Approval routing failure does NOT roll back the scope_exception row;
      // the violation must still be recorded. Caller sees approval_request_id=null.
      console.error(
        '[scope-enforcement] sdk-approval submitRequest failed',
        (approvalErr as Error).message,
      );
    }
  }

  try {
    await appendAuditEntry({
      pool_index: AGENT_AUDIT_POOL,
      event_type: 'agent.scope.exceeded.v1',
      actor_kind: 'agent',
      actor_id: input.agent_id,
      tenant_id: agent.tenant_id,
      subject_kind: 'agent.scope_exception',
      subject_id: exceptionRow.exception_id,
      retention_class: 'regulated',
      payload: {
        agent_id: input.agent_id,
        run_id: input.run_id,
        acting_persona_id: input.acting_persona_id,
        requested_sku: input.requested_sku,
        approval_request_id,
        route_configured: routeId !== null,
      },
    });
  } catch (auditErr) {
    console.error(
      '[scope-enforcement] audit emit failed for exception',
      exceptionRow.exception_id,
      (auditErr as Error).message,
    );
  }

  throw new ScopeViolationError({
    message: `[scope-enforcement] tool_sku "${input.requested_sku}" not in agent ${input.agent_id} tool_manifest; exception ${exceptionRow.exception_id}${
      approval_request_id ? `, approval ${approval_request_id} pending` : ', no approval route configured'
    }`,
    requested_sku: input.requested_sku,
    agent_id: input.agent_id,
    exception_id: exceptionRow.exception_id,
    approval_request_id,
  });
}

export interface ResolveExceptionInput {
  exception_id: string;
  outcome: 'approved' | 'denied' | 'timed-out';
}

/**
 * Called by the sdk-approval webhook (or polled by an external worker) when
 * a scope_exception's underlying approval reaches a terminal decision.
 * Marks the exception row + records resolved_at. Future minting can
 * succeed once outcome='approved' by checking the recent scope_exception
 * table — but the gate logic stays in enforceToolManifest above; this
 * is purely a state-tracking helper.
 */
export async function resolveScopeException(input: ResolveExceptionInput): Promise<void> {
  await dataService.query(
    `UPDATE agents.scope_exception
        SET outcome = $2, resolved_at = now()
      WHERE exception_id = $1`,
    [input.exception_id, input.outcome],
  );
}
