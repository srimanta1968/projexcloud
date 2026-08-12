import { dataService } from '@projexlight/db-runtime';
import { emitEvent } from '@projexlight/sdk-audit';
import { CONSENT_ABSENT_REASON, hasActiveConsent } from '@projexlight/contracts';
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
    `INSERT INTO policy.policy (tenant_id, app_id, name, iql_source, cedar_compiled, version, obligations)
     VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7::jsonb)
     RETURNING policy_id, tenant_id, app_id, name, iql_source, cedar_compiled,
               version, status, created_at, updated_at, obligations`,
    [
      input.tenant_id ?? null,
      input.app_id ?? null,
      input.name,
      input.iql_source,
      JSON.stringify(cedar),
      input.version,
      input.obligations ? JSON.stringify(input.obligations) : null,
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
    `SELECT policy_id, tenant_id, app_id, name, iql_source, cedar_compiled,
            version, status, created_at, updated_at, obligations
       FROM policy.policy WHERE policy_id = $1`,
    [policy_id],
  );
}

/**
 * Active policies governing one app, most specific first.
 *
 * Returns the app's own rules ahead of the tenant-wide rules it inherits, so a
 * caller iterating the list meets an override before the rule it overrides.
 *
 * DELIBERATELY NOT A "first match wins" RESOLVER like resolveConfig. A config
 * key has one value and the most specific scope answers; access rules COMPOSE —
 * a tenant-wide rule and an app rule are both in force, and silently dropping
 * the tenant-wide one because an app rule exists would widen access at exactly
 * the moment somebody added a restriction. The ordering is for presentation and
 * for callers that genuinely want the narrowest rule; it is not permission to
 * ignore the rest.
 */
export async function listPoliciesForScope(
  tenant_id: string,
  app_id?: string | null,
): Promise<PolicyRecord[]> {
  if (!tenant_id) throw new Error('policy: tenant_id is required to list policies');
  if (app_id) {
    return dataService.rows<PolicyRecord>(
      `SELECT policy_id, tenant_id, app_id, name, iql_source, cedar_compiled,
              version, status, created_at, updated_at, obligations
         FROM policy.policy
        WHERE tenant_id = $1 AND status = 'active'
          AND (app_id = $2 OR app_id IS NULL)
        ORDER BY (app_id IS NULL), name, version`,
      [tenant_id, app_id],
    );
  }
  return dataService.rows<PolicyRecord>(
    `SELECT policy_id, tenant_id, app_id, name, iql_source, cedar_compiled,
            version, status, created_at, updated_at, obligations
       FROM policy.policy
      WHERE tenant_id = $1 AND status = 'active' AND app_id IS NULL
      ORDER BY name, version`,
    [tenant_id],
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
  try {
    return await evaluatePolicyCore(input);
  } catch (err) {
    // A genuine "policy not found" is a 404, not evaluator degradation.
    if (/not found/i.test((err as Error).message)) throw err;
    // P10/E4: fail-closed on evaluator unavailability (DB/cache/cedar error).
    return failClosedDecision(input, err as Error);
  }
}

/**
 * The decision itself, with no I/O: Cedar over the context, then the consent gate.
 *
 * Extracted so the single and bulk evaluators cannot drift. A bulk path with its
 * own copy of the consent gate is one refactor away from disagreeing with the
 * single path about a DENY, and the two are supposed to be the same question
 * asked about a different number of subjects.
 */
function computeDecision(
  policy: PolicyRecord,
  input: EvaluatePolicyInput,
): { result: Omit<EvaluatePolicyResult, 'cached'>; consentSatisfied: boolean; purposeBound: boolean } {
  const ctx = (input.context ?? {}) as Record<string, unknown>;
  const projection_version = typeof ctx.projection_version === 'number' ? ctx.projection_version : 0;
  const purposeBound = input.purpose_bound === true;

  const policyAllows = evaluateCedar(
    policy.cedar_compiled as ReturnType<typeof compileToCedar>,
    ctx,
  );

  // P10/E3: consent gating. For a purpose-bound resource a valid consent
  // receipt is REQUIRED; absent/expired/revoked consent fails closed (DENY)
  // regardless of the policy verdict, with a distinct auditable reason code.
  const consentSatisfied =
    !purposeBound || hasActiveConsent(input.consent_receipts, input.purpose ?? '');
  const allowed = policyAllows && consentSatisfied;
  const reason = !consentSatisfied
    ? `${CONSENT_ABSENT_REASON}: no active consent for purpose '${input.purpose ?? '(unspecified)'}'`
    : allowed
      ? `Policy ${policy.name}@${policy.version} permits the access`
      : `Policy ${policy.name}@${policy.version} did not match the conditions`;

  const layers_used = layersTouchedByContext(ctx);
  if (purposeBound) layers_used.push('consent');
  // P10/E1: obligations only attach to an ALLOW; a DENY (or an obligation-free
  // bundle) yields the pre-P10 allow/deny result with no obligations field.
  const obligations = allowed && policy.obligations ? policy.obligations : undefined;
  return {
    result: {
      decision: allowed ? 'ALLOW' : 'DENY',
      reason,
      layers_used,
      projection_version,
      ...(obligations ? { obligations } : {}),
    },
    consentSatisfied,
    purposeBound,
  };
}

async function evaluatePolicyCore(input: EvaluatePolicyInput): Promise<EvaluatePolicyResult> {
  const policy = await getPolicy(input.policy_id);
  if (!policy) throw new Error(`Policy ${input.policy_id} not found`);

  const ctx = (input.context ?? {}) as Record<string, unknown>;
  const projection_version = typeof ctx.projection_version === 'number' ? ctx.projection_version : 0;

  // P10/E3: purpose-bound evaluations skip the precomp cache so consent
  // revocation/expiry take effect on the very next decision (live, never stale).
  const purposeBound = input.purpose_bound === true;
  const cached = purposeBound
    ? null
    : await getCached(input.policy_id, input.subject_id, input.target_id, projection_version);
  if (cached) {
    return cached;
  }

  const { result, consentSatisfied } = computeDecision(policy, input);
  const obligations = result.obligations;
  const layers_used = result.layers_used;

  await dataService.query(
    `INSERT INTO policy.decision (policy_id, subject_id, target_id, decision, reason, layers_used, projection_version, obligations)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)`,
    [
      input.policy_id,
      input.subject_id,
      input.target_id ?? null,
      result.decision,
      result.reason,
      layers_used,
      projection_version,
      obligations ? JSON.stringify(obligations) : null,
    ],
  );

  // Never cache purpose-bound decisions — consent state is live (E3).
  if (!purposeBound) {
    await setCached(input.policy_id, input.subject_id, input.target_id, projection_version, result);
  }

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
      // P10/E1: surface obligations in the audit chain so policy observability
      // can see what mask/filter/audit_level/ttl was enforced per decision.
      obligations: obligations ?? null,
      // P10/E3: surface the consent gate so consent observability can see the
      // purpose and whether a consent-derived denial occurred.
      purpose: input.purpose ?? null,
      purpose_bound: purposeBound,
      consent_satisfied: consentSatisfied,
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

export interface BulkEvaluateItem extends EvaluatePolicyInput {
  index: number;
}

export interface BulkEvaluateRow extends EvaluatePolicyResult {
  index: number;
}

export type BulkEvaluateOutcome =
  | { index: number; ok: true; result: EvaluatePolicyResult }
  | { index: number; ok: false; error_code: 'POLICY_NOT_FOUND'; error: string };

/**
 * Evaluate N (policy, subject) pairs in one request.
 *
 * WHAT MAKES THIS CHEAPER THAN N CALLS, precisely — because a loop behind a
 * `/bulk` route would look identical from outside and fix nothing:
 *
 *   * ONE policy read per DISTINCT policy_id, not per item. A campaign check
 *     evaluates one policy against thousands of subjects, so this collapses N
 *     reads to 1 — the single largest cost in the old path.
 *   * ONE INSERT for every decision row, via unnest. The decision log stays
 *     complete; it is written once rather than N times.
 *   * ONE audit event per distinct policy, not per subject. See below.
 *   * Cedar evaluation stays per item, in process, against an already-compiled
 *     term. It is the only genuinely per-subject work and it does no I/O.
 *
 * THE AUDIT FAN-OUT IS AGGREGATED, AND THAT IS A REAL SEMANTIC CHANGE.
 * `policy.evaluated.v1` appends to a hash-linked chain, so N of them are
 * serialized by construction and a 1000-subject batch would spend its entire
 * budget in the audit writer. A bulk evaluation emits ONE
 * `policy.evaluated-bulk.v1` naming the policy, the batch size and the
 * allow/deny split. The per-decision durable record is unaffected: every single
 * decision is still written to `policy.decision`, which is the queryable record
 * of what was decided about whom. What the aggregate event gives up is
 * per-subject granularity IN THE AUDIT CHAIN, and a caller that needs that must
 * use the single endpoint — which is the honest trade rather than pretending
 * batching is free.
 *
 * PARTIAL FAILURE: an item naming a policy that does not exist gets its own
 * POLICY_NOT_FOUND outcome. The single endpoint answers 404 for that, which is
 * right when the request IS one evaluation; failing 10,000 verdicts because one
 * of them named a deleted policy is not.
 */
export async function evaluatePolicyBulk(items: BulkEvaluateItem[]): Promise<BulkEvaluateOutcome[]> {
  if (items.length === 0) return [];

  const wantedIds = [...new Set(items.map((i) => i.policy_id))];
  // Compared as text deliberately. policy_id is a uuid column, so `= ANY($1::uuid[])`
  // would throw on a single malformed id and take the whole batch with it — the exact
  // batch-wide failure this endpoint exists to avoid. The list is one entry per
  // distinct policy (usually 1), so the lost index is not worth the fragility.
  const found = await dataService.rows<PolicyRecord>(
    `SELECT policy_id, tenant_id, app_id, name, iql_source, cedar_compiled,
            version, status, created_at, updated_at, obligations
       FROM policy.policy
      WHERE policy_id::text = ANY($1::text[])`,
    [wantedIds],
  );
  const policies = new Map(found.map((p) => [String(p.policy_id), p]));

  const outcomes: BulkEvaluateOutcome[] = [];
  const evaluated: Array<{ item: BulkEvaluateItem; policy: PolicyRecord; result: Omit<EvaluatePolicyResult, 'cached'> }> = [];

  for (const item of items) {
    const policy = policies.get(item.policy_id);
    if (!policy) {
      outcomes.push({
        index: item.index,
        ok: false,
        error_code: 'POLICY_NOT_FOUND',
        error: `Policy ${item.policy_id} not found`,
      });
      continue;
    }
    try {
      const { result } = computeDecision(policy, item);
      evaluated.push({ item, policy, result });
    } catch (err) {
      // A compiled term that will not evaluate is evaluator degradation for THIS
      // item, not a reason to deny the rest. Same fail-closed rule as the single
      // path: sensitive denies, and the degraded flag says why.
      outcomes.push({
        index: item.index,
        ok: true,
        result: {
          decision: 'DENY',
          reason: `evaluator_unavailable: fail-closed (${(err as Error).message})`,
          layers_used: [],
          projection_version: 0,
          cached: false,
          degraded: true,
        },
      });
    }
  }

  if (evaluated.length > 0) {
    // One statement, rows unpacked from a jsonb array rather than parallel
    // unnest() arrays: layers_used is itself TEXT[], and a Postgres text[][]
    // parameter must be rectangular — it would flatten "subject,target" and
    // "subject" into one ragged array and fail (or worse, silently mis-shape).
    await dataService.query(
      `INSERT INTO policy.decision
         (policy_id, subject_id, target_id, decision, reason, layers_used, projection_version, obligations)
       SELECT (r->>'policy_id')::uuid,
              (r->>'subject_id')::uuid,
              NULLIF(r->>'target_id', '')::uuid,
              r->>'decision',
              r->>'reason',
              ARRAY(SELECT jsonb_array_elements_text(r->'layers_used')),
              (r->>'projection_version')::bigint,
              CASE WHEN r->'obligations' IS NULL OR r->'obligations' = 'null'::jsonb
                   THEN NULL ELSE r->'obligations' END
         FROM jsonb_array_elements($1::jsonb) AS r`,
      [
        JSON.stringify(evaluated.map((e) => ({
          policy_id: e.item.policy_id,
          subject_id: e.item.subject_id,
          target_id: e.item.target_id ?? '',
          decision: e.result.decision,
          reason: e.result.reason,
          layers_used: e.result.layers_used,
          projection_version: e.result.projection_version,
          obligations: e.result.obligations ?? null,
        }))),
      ],
    );

    for (const e of evaluated) {
      outcomes.push({ index: e.item.index, ok: true, result: { ...e.result, cached: false } });
    }

    // One event per distinct policy, carrying the split rather than the subjects.
    const byPolicy = new Map<string, typeof evaluated>();
    for (const e of evaluated) {
      const list = byPolicy.get(e.item.policy_id) ?? [];
      list.push(e);
      byPolicy.set(e.item.policy_id, list);
    }
    for (const [policy_id, group] of byPolicy) {
      const policy = group[0].policy;
      const allowed = group.filter((e) => e.result.decision === 'ALLOW').length;
      await emitEvent({
        event_type: 'policy.evaluated-bulk.v1',
        payload: {
          policy_id,
          policy_name: policy.name,
          policy_version: policy.version,
          evaluated: group.length,
          allowed,
          denied: group.length - allowed,
          purpose_bound: group.some((e) => e.item.purpose_bound === true),
        },
        pool_index: POOL_INDEX,
        actor_kind: 'service',
        actor_id: 'sdk-policy.evaluateBulk',
        tenant_id: policy.tenant_id,
        subject_kind: 'policy',
        subject_id: policy_id,
      });
    }
  }

  // The caller zips these onto its own subject list, so the order it sent is the
  // order it gets back — regardless of which bucket each item passed through.
  return outcomes.sort((a, b) => a.index - b.index);
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

/**
 * P10/E4: produces a fail-closed decision when the evaluator is unavailable.
 * Sensitive (default) classes DENY; low-risk classes may serve a short-TTL
 * cached decision if one exists. Every degraded decision is audited best-effort.
 */
async function failClosedDecision(input: EvaluatePolicyInput, err: Error): Promise<EvaluatePolicyResult> {
  const ctx = (input.context ?? {}) as Record<string, unknown>;
  const projection_version = typeof ctx.projection_version === 'number' ? ctx.projection_version : 0;
  const resourceClass = input.resource_class ?? 'sensitive';

  let result: EvaluatePolicyResult;
  if (resourceClass === 'low_risk') {
    const cached = await getCached(
      input.policy_id,
      input.subject_id,
      input.target_id,
      projection_version,
    ).catch(() => null);
    result = cached
      ? { ...cached, cached: true, degraded: true }
      : {
          decision: 'DENY',
          reason: `evaluator_unavailable: no cached low-risk decision (${err.message})`,
          layers_used: [],
          projection_version,
          cached: false,
          degraded: true,
        };
  } else {
    result = {
      decision: 'DENY',
      reason: `evaluator_unavailable: fail-closed for sensitive resource (${err.message})`,
      layers_used: [],
      projection_version,
      cached: false,
      degraded: true,
    };
  }

  // Best-effort degraded-decision audit — never throw from the fail-closed path.
  try {
    await emitEvent({
      event_type: 'policy.evaluated.v1',
      payload: {
        policy_id: input.policy_id,
        subject_id: input.subject_id,
        target_id: input.target_id ?? null,
        decision: result.decision,
        reason: result.reason,
        degraded: true,
        resource_class: resourceClass,
        error: err.message,
      },
      pool_index: POOL_INDEX,
      actor_kind: 'service',
      actor_id: 'sdk-policy.evaluate.failclosed',
      tenant_id: null,
      subject_kind: 'persona',
      subject_id: input.subject_id,
    });
  } catch {
    // swallow — degraded audit is best-effort and must not mask the denial
  }
  return result;
}

function layersTouchedByContext(ctx: Record<string, unknown>): string[] {
  const layers: string[] = [];
  if (ctx.subject) layers.push('subject');
  if (ctx.encounter) layers.push('encounter');
  if (ctx.rebac) layers.push('rebac');
  if (ctx.target) layers.push('target');
  return layers;
}
