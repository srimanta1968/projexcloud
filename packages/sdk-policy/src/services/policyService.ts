import { dataService } from '@projexlight/db-runtime';
import { emitEvent } from '@projexlight/sdk-audit';
import { compileToCedar, evaluateCedar, parseIQL } from './iqlParser';
import { getCached, setCached } from './precompCache';

const POOL_INDEX = process.env.POOL_INDEX || 'admin';
import type {
  CreatePolicyInput,
  EvaluatePolicyInput,
  EvaluatePolicyResult,
  PolicyRecord,
} from '../models/policy.model';

/**
 * sdk-policy service layer per P2 §5.4 / FR-POL-1..9.
 */

/**
 * Creates a versioned policy bundle. Compiles IQL source to a Cedar term
 * eagerly so reads don't re-parse on every evaluate (FR-POL-4).
 */
export async function createPolicy(input: CreatePolicyInput, actor_id = 'system'): Promise<PolicyRecord> {
  const ast = parseIQL(input.iql_source);
  const cedar = compileToCedar(ast);
  const rows = await dataService.rows<PolicyRecord>(
    `INSERT INTO policy.policy (tenant_id, name, iql_source, cedar_compiled, version)
     VALUES ($1, $2, $3, $4::jsonb, $5)
     RETURNING policy_id, tenant_id, name, iql_source, cedar_compiled,
               version, status, created_at, updated_at`,
    [
      input.tenant_id ?? null,
      input.name,
      input.iql_source,
      JSON.stringify(cedar),
      input.version,
    ],
  );
  const policy = rows[0];
  await emitPolicyUpdated(policy, actor_id);
  return policy;
}

/**
 * Reads one policy by id. Returns null if not found.
 */
export async function getPolicy(policy_id: string): Promise<PolicyRecord | null> {
  return dataService.one<PolicyRecord>(
    `SELECT policy_id, tenant_id, name, iql_source, cedar_compiled,
            version, status, created_at, updated_at
       FROM policy.policy WHERE policy_id = $1`,
    [policy_id],
  );
}

/**
 * Evaluates a policy. Checks the precomp cache first (FR-POL-9); on miss
 * runs the compiled Cedar term against the supplied context, writes the
 * sampled decision row + caches the result keyed by projection_version.
 *
 * The projection_version is fetched from context or defaults to 0 (no
 * projection yet); when sdk-identity-resolver lands in P3 the resolver will
 * inject the current version into the context.
 */
export async function evaluatePolicy(input: EvaluatePolicyInput): Promise<EvaluatePolicyResult> {
  const policy = await getPolicy(input.policy_id);
  if (!policy) throw new Error(`Policy ${input.policy_id} not found`);

  const ctx = (input.context ?? {}) as Record<string, unknown>;
  const projection_version = typeof ctx.projection_version === 'number' ? ctx.projection_version : 0;

  const cached = await getCached(input.policy_id, input.subject_id, input.target_id, projection_version);
  if (cached) {
    return cached;
  }

  const allowed = evaluateCedar(
    policy.cedar_compiled as ReturnType<typeof compileToCedar>,
    ctx,
  );
  const reason = allowed
    ? `Policy ${policy.name}@${policy.version} permits the access`
    : `Policy ${policy.name}@${policy.version} did not match the conditions`;

  const layers_used = layersTouchedByContext(ctx);
  const result: Omit<EvaluatePolicyResult, 'cached'> = {
    decision: allowed ? 'ALLOW' : 'DENY',
    reason,
    layers_used,
    projection_version,
  };

  await dataService.query(
    `INSERT INTO policy.decision (policy_id, subject_id, target_id, decision, reason, layers_used, projection_version)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [
      input.policy_id,
      input.subject_id,
      input.target_id ?? null,
      result.decision,
      result.reason,
      layers_used,
      projection_version,
    ],
  );

  await setCached(input.policy_id, input.subject_id, input.target_id, projection_version, result);

  // FR-POL-3: fan-out sampled decisions to sdk-audit. Best-effort; never
  // blocks the evaluator hot path (emitEvent swallows failures).
  await emitEvent({
    event_type: 'policy.evaluated.v1',
    payload: {
      policy_id: input.policy_id,
      policy_name: policy.name,
      policy_version: policy.version,
      subject_id: input.subject_id,
      target_id: input.target_id ?? null,
      decision: result.decision,
      reason: result.reason,
      layers_used: result.layers_used,
      projection_version,
    },
    pool_index: POOL_INDEX,
    actor_kind: 'service',
    actor_id: 'sdk-policy.evaluate',
    tenant_id: policy.tenant_id,
    subject_kind: 'persona',
    subject_id: input.subject_id,
  });

  return { ...result, cached: false };
}

/**
 * FR-POL-4: also emit policy.updated.v1 on createPolicy so the audit chain
 * captures every policy bundle introduction (regulated retention).
 */
export async function emitPolicyUpdated(policy: PolicyRecord, actor_id: string): Promise<void> {
  await emitEvent({
    event_type: 'policy.updated.v1',
    payload: {
      policy_id: policy.policy_id,
      name: policy.name,
      version: policy.version,
      status: policy.status,
    },
    pool_index: POOL_INDEX,
    actor_kind: 'human',
    actor_id,
    tenant_id: policy.tenant_id,
    subject_kind: 'policy',
    subject_id: policy.policy_id,
  });
}

function layersTouchedByContext(ctx: Record<string, unknown>): string[] {
  const layers: string[] = [];
  if (ctx.subject) layers.push('subject');
  if (ctx.encounter) layers.push('encounter');
  if (ctx.rebac) layers.push('rebac');
  if (ctx.target) layers.push('target');
  return layers;
}
