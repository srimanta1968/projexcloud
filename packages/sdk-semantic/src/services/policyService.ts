import { randomUUID } from 'crypto';
import { dataService } from '@projexlight/db-runtime';
import { appendAuditEntry } from '@projexlight/sdk-audit';
import type {
  SemanticPolicyRef,
  SemanticPolicyDecision,
  SemanticPolicyStatus,
} from '@projexlight/contracts';

/**
 * sdk-semantic SemanticPolicy compiler + evaluator (G9 closer · AC-9).
 *
 * Policies are authored in IQL (Identity Query Language — declared by P2 sdk-
 * policy contracts) and compile down to:
 *   - compiled_abac: a flat ABAC expression (string) that sdk-policy can
 *                    feed to its existing evaluator.
 *   - compiled_rebac: a JSON spec of required ReBAC edges the caller's
 *                     identity context must present (e.g. care-team edge
 *                     from Doctor to Patient).
 *
 * The v1 compiler supports the example from PRD AC-9:
 *   "A Doctor with active care-team Relation to a Patient may write a
 *    Prescription for that Patient."
 *
 * Grammar (v1, intentionally small):
 *   ALLOW <subject_type> WITH <relation_name>(<object_type>) TO <verb> <object_type>
 *   DENY  <subject_type> TO <verb> <object_type>
 *
 * Future versions extend the parser; the runtime evaluator already handles
 * the compiled forms.
 *
 * PRD §6 target: Policy evaluation ≤5ms p99.
 */

const SEMANTIC_AUDIT_POOL = process.env.SEMANTIC_AUDIT_POOL || 'admin-default';

export interface RegisterPolicyInput {
  tenant_id: string | null;
  ontology_id: string;
  name: string;
  description?: string;
  iql_source: string;
  activate?: boolean;
}

export interface CompiledPolicy {
  compiled_abac: string;
  compiled_rebac: Record<string, unknown>;
}

interface PolicyRow {
  policy_id: string;
  tenant_id: string | null;
  ontology_id: string;
  name: string;
  description: string | null;
  iql_source: string;
  compiled_abac: string;
  compiled_rebac: Record<string, unknown>;
  status: string;
}

function rowToPolicy(r: PolicyRow): SemanticPolicyRef {
  return {
    policy_id: r.policy_id,
    tenant_id: r.tenant_id,
    ontology_id: r.ontology_id,
    name: r.name,
    description: r.description ?? undefined,
    iql_source: r.iql_source,
    compiled_abac: r.compiled_abac,
    compiled_rebac: r.compiled_rebac,
    status: r.status as SemanticPolicyStatus,
  };
}

/**
 * Compile an IQL source. The v1 grammar is small enough that a hand-rolled
 * parser is simpler than pulling in a PEG generator; future versions migrate
 * to the shared sdk-policy parser when that ships.
 */
export function compileIql(iql_source: string): CompiledPolicy {
  const src = iql_source.trim();
  // ALLOW Doctor WITH care-team(Patient) TO write Prescription
  // DENY  <subject> TO <verb> <object>
  const allowRe = /^ALLOW\s+(\S+)\s+WITH\s+(\S+)\((\S+)\)\s+TO\s+(\S+)\s+(\S+)\s*$/i;
  const denyRe = /^DENY\s+(\S+)\s+TO\s+(\S+)\s+(\S+)\s*$/i;

  const allow = src.match(allowRe);
  if (allow) {
    const [, subjectType, relationName, relationTarget, verb, objectType] = allow;
    return {
      compiled_abac:
        `subject.type == "${subjectType}" && action == "${verb}" && resource.type == "${objectType}"`,
      compiled_rebac: {
        effect: 'allow',
        require_edges: [
          {
            kind: relationName,
            from_object_type: subjectType,
            to_object_type: relationTarget,
            active: true,
          },
        ],
      },
    };
  }

  const deny = src.match(denyRe);
  if (deny) {
    const [, subjectType, verb, objectType] = deny;
    return {
      compiled_abac:
        `subject.type == "${subjectType}" && action == "${verb}" && resource.type == "${objectType}"`,
      compiled_rebac: { effect: 'deny', require_edges: [] },
    };
  }

  throw new Error(
    `[sdk-semantic] IQL parse failed. v1 grammar:\n  ALLOW <type> WITH <relation>(<target>) TO <verb> <object>\n  DENY <type> TO <verb> <object>\nSource: ${iql_source}`,
  );
}

export async function registerPolicy(input: RegisterPolicyInput): Promise<SemanticPolicyRef> {
  const compiled = compileIql(input.iql_source);
  const status: SemanticPolicyStatus = input.activate ? 'active' : 'draft';

  const row = await dataService.one<PolicyRow>(
    `INSERT INTO semantic.policy
       (policy_id, tenant_id, ontology_id, name, description, iql_source,
        compiled_abac, compiled_rebac, status)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     ON CONFLICT (tenant_id, name) DO UPDATE
       SET iql_source = EXCLUDED.iql_source,
           compiled_abac = EXCLUDED.compiled_abac,
           compiled_rebac = EXCLUDED.compiled_rebac,
           status = EXCLUDED.status,
           description = EXCLUDED.description
     RETURNING policy_id, tenant_id, ontology_id, name, description,
               iql_source, compiled_abac, compiled_rebac, status`,
    [
      randomUUID(),
      input.tenant_id,
      input.ontology_id,
      input.name,
      input.description ?? null,
      input.iql_source,
      compiled.compiled_abac,
      compiled.compiled_rebac,
      status,
    ],
  );

  return rowToPolicy(row!);
}

export interface EvaluateContext {
  /** Acting persona's resolved object type (e.g. Doctor). */
  subject_type: string;
  subject_id: string;
  /** Verb being performed (e.g. write). */
  action: string;
  /** Resource being acted upon (e.g. Prescription). */
  resource_type: string;
  resource_id: string;
  /**
   * Active ReBAC edges the subject holds. Caller resolves these via
   * sdk-rebac before invoking evaluate. Format mirrors what compileIql
   * encodes in compiled_rebac.require_edges.
   */
  active_edges: Array<{
    kind: string;
    from_object_type: string;
    to_object_type: string;
    to_object_id: string;
    active: boolean;
  }>;
  trace_id: string;
}

/**
 * Synchronous evaluator: walks the compiled ABAC + ReBAC requirements and
 * returns a decision in ≤5ms p99.
 *
 * ABAC is evaluated as a simple boolean over (subject, action, resource).
 * ReBAC checks every require_edge against ctx.active_edges with exact-
 * match on (kind, from_type, to_type, to_id, active).
 */
export async function evaluate(policy_id: string, ctx: EvaluateContext): Promise<SemanticPolicyDecision> {
  const t0 = Date.now();
  const policy = await dataService.one<PolicyRow>(
    `SELECT policy_id, tenant_id, ontology_id, name, description, iql_source,
            compiled_abac, compiled_rebac, status
       FROM semantic.policy
      WHERE policy_id = $1`,
    [policy_id],
  );
  if (!policy) {
    throw new Error(`[sdk-semantic] policy '${policy_id}' not found`);
  }
  if (policy.status !== 'active') {
    return finishDecision(policy_id, 'deny', `policy not active (status=${policy.status})`, t0, ctx.trace_id);
  }

  const abacOk = evaluateAbac(policy.compiled_abac, ctx);
  if (!abacOk) {
    return finishDecision(policy_id, 'deny', 'ABAC predicate did not match', t0, ctx.trace_id);
  }

  const rebac = policy.compiled_rebac as { effect: 'allow' | 'deny'; require_edges: EdgeReq[] };
  if (rebac.effect === 'deny') {
    return finishDecision(policy_id, 'deny', 'DENY policy matched', t0, ctx.trace_id);
  }

  for (const req of rebac.require_edges ?? []) {
    const hit = ctx.active_edges.some(
      (e) =>
        e.kind === req.kind &&
        e.from_object_type === req.from_object_type &&
        e.to_object_type === req.to_object_type &&
        e.to_object_id === ctx.resource_id &&
        (!req.active || e.active),
    );
    if (!hit) {
      return finishDecision(
        policy_id,
        'deny',
        `missing required ${req.kind} edge ${req.from_object_type}→${req.to_object_type}=${ctx.resource_id}`,
        t0,
        ctx.trace_id,
      );
    }
  }

  return finishDecision(policy_id, 'allow', 'ALLOW policy matched + all required edges present', t0, ctx.trace_id);
}

interface EdgeReq {
  kind: string;
  from_object_type: string;
  to_object_type: string;
  active: boolean;
}

function evaluateAbac(expr: string, ctx: EvaluateContext): boolean {
  // The v1 compiler emits a fixed shape:
  //   subject.type == "<S>" && action == "<A>" && resource.type == "<R>"
  // Parse it back instead of using eval. Safe and fast.
  const m = expr.match(
    /^subject\.type == "([^"]+)" && action == "([^"]+)" && resource\.type == "([^"]+)"$/,
  );
  if (!m) {
    // Unknown shape — fail closed.
    return false;
  }
  const [, subjectType, action, resourceType] = m;
  return (
    ctx.subject_type === subjectType &&
    ctx.action === action &&
    ctx.resource_type === resourceType
  );
}

async function finishDecision(
  policy_id: string,
  decision: 'allow' | 'deny',
  reason: string,
  t0: number,
  trace_id: string,
): Promise<SemanticPolicyDecision> {
  const latency_ms = Date.now() - t0;
  const result: SemanticPolicyDecision = { policy_id, decision, reason, latency_ms, trace_id };
  // Audit emit is best-effort — never block the decision.
  try {
    await appendAuditEntry({
      event_type: 'semantic.policy.evaluated.v1',
      payload: { policy_id, decision, reason, latency_ms, trace_id },
      pool_index: SEMANTIC_AUDIT_POOL,
      actor_kind: 'service',
      actor_id: 'sdk-semantic',
      retention_class: 'operational',
    });
  } catch (err) {
    console.warn('[sdk-semantic] policy decision audit failed:', err);
  }
  return result;
}

export async function listPolicies(filter: { tenant_id?: string | null; ontology_id?: string } = {}): Promise<SemanticPolicyRef[]> {
  const rows = await dataService.rows<PolicyRow>(
    `SELECT policy_id, tenant_id, ontology_id, name, description, iql_source,
            compiled_abac, compiled_rebac, status
       FROM semantic.policy
      WHERE ($1::uuid IS NULL OR tenant_id = $1)
        AND ($2::text IS NULL OR ontology_id = $2)
      ORDER BY name`,
    [filter.tenant_id ?? null, filter.ontology_id ?? null],
  );
  return rows.map(rowToPolicy);
}
