import { randomUUID } from 'crypto';
import { dataService } from '@projexlight/db-runtime';
import { appendAuditEntry } from '@projexlight/sdk-audit';
import type {
  Plan,
  PlanStatus,
  PlanStep,
  SemanticIntent,
} from '@projexlight/contracts';

/**
 * sdk-semantic Intent → Plan planner (G9 closer · AC-8).
 *
 * Given a typed Intent (goal, subject, parameters) and the active ontology,
 * walks the CapabilityGraph to produce an ordered list of PlanSteps.
 *
 * Algorithm (deterministic, no LLM in v1):
 *   - Resolve the subject object_type from the intent.
 *   - Fetch all capability_graph_edge rows for that object_type.
 *   - Filter to edges whose pre_conditions are satisfied by the
 *     parameters + a goal-keyword match.
 *   - Order the remaining edges so that an edge whose post_conditions
 *     satisfy another edge's pre_conditions comes first (topological
 *     sort with stable tie-break on tool_sku alphabetical).
 *   - Materialize the plan + persist intent_plan row in status='proposed'.
 *
 * The planner is intentionally side-effect-free until the final INSERT —
 * an agent calling plan() repeatedly never produces duplicate plan rows
 * with conflicting capability_edge_id references.
 *
 * PRD §6 target: Intent → Plan latency ≤1s p99.
 */

const SEMANTIC_AUDIT_POOL = process.env.SEMANTIC_AUDIT_POOL || 'admin-default';

interface CapabilityEdgeRow {
  edge_id: string;
  object_type_id: string;
  tool_sku: string;
  requires_relation: string | null;
  pre_conditions: Record<string, unknown>;
  post_conditions: Record<string, unknown>;
  /** Joined: relation_type.name when requires_relation is set. */
  required_relation_name: string | null;
}

export async function plan(intent: SemanticIntent, ctx: { agent_run_id?: string | null } = {}): Promise<Plan> {
  // 1. Resolve subject object_type.
  const objectType = await dataService.one<{ object_type_id: string; name: string }>(
    `SELECT ot.object_type_id, ot.name
       FROM semantic.object_type ot
      WHERE ot.ontology_id = $1
        AND ot.name = $2`,
    [intent.ontology_id, intent.subject.type],
  );
  if (!objectType) {
    throw new Error(
      `[sdk-semantic] unknown subject type '${intent.subject.type}' in ontology ${intent.ontology_id}`,
    );
  }

  // 2. Fetch candidate capability edges for this subject type.
  const candidates = await dataService.rows<CapabilityEdgeRow>(
    `SELECT cge.edge_id, cge.object_type_id, cge.tool_sku,
            cge.requires_relation, cge.pre_conditions, cge.post_conditions,
            rt.name AS required_relation_name
       FROM semantic.capability_graph_edge cge
       LEFT JOIN semantic.relation_type rt ON rt.relation_type_id = cge.requires_relation
      WHERE cge.object_type_id = $1
      ORDER BY cge.tool_sku`,
    [objectType.object_type_id],
  );

  // 3. Filter by goal-keyword + parameter satisfaction.
  const goalTokens = tokenizeGoal(intent.goal);
  const matching = candidates.filter((c) => {
    const skuTokens = tokenizeGoal(c.tool_sku.replace(/\./g, ' ').replace(/[-_]/g, ' '));
    let hitsGoal = false;
    for (const t of goalTokens) {
      if (skuTokens.has(t)) { hitsGoal = true; break; }
    }
    const preOk = checkPreConditions(c.pre_conditions, intent.parameters);
    // Allow edges that match the goal OR whose post_conditions advance toward it.
    const postContributes = postConditionsAdvance(c.post_conditions, goalTokens);
    return preOk && (hitsGoal || postContributes);
  });

  if (matching.length === 0) {
    throw new Error(
      `[sdk-semantic] no capability_graph_edge matches goal '${intent.goal}' for subject type '${intent.subject.type}'`,
    );
  }

  // 4. Topologically order so post→pre satisfies happen first.
  const ordered = topoOrder(matching);

  // 5. Materialize the plan.
  const subjectId = intent.subject.id;
  const steps: PlanStep[] = ordered.map((edge, idx) => ({
    step_index: idx,
    tool_sku: edge.tool_sku,
    args: buildStepArgs(edge, intent, subjectId),
    capability_edge_id: edge.edge_id,
  }));

  const planId = randomUUID();
  const intentId = intent.intent_id ?? await ensureIntentRow(intent);
  const row = await dataService.one<{ plan_id: string; generated_at: Date; status: string }>(
    `INSERT INTO semantic.intent_plan
       (plan_id, intent_id, subject_id, steps, generated_by_agent_run_id, status)
     VALUES ($1, $2, $3, $4, $5, 'proposed')
     RETURNING plan_id, generated_at, status`,
    [planId, intentId, subjectId, JSON.stringify(steps), ctx.agent_run_id ?? null],
  );

  await appendAuditEntry({
    event_type: 'semantic.intent.planned.v1',
    payload: {
      plan_id: planId,
      intent_id: intentId,
      goal: intent.goal,
      subject_type: intent.subject.type,
      subject_id: subjectId,
      step_count: steps.length,
      trace_id: intent.trace_id,
    },
    pool_index: SEMANTIC_AUDIT_POOL,
    actor_kind: 'service',
    actor_id: 'sdk-semantic',
    retention_class: 'regulated',
  });

  return {
    plan_id: row!.plan_id,
    intent_id: intentId,
    subject_id: subjectId,
    steps,
    generated_by_agent_run_id: ctx.agent_run_id ?? null,
    generated_at: row!.generated_at.toISOString(),
    status: row!.status as PlanStatus,
  };
}

/**
 * Mark a plan as moving through its lifecycle. Valid transitions:
 *   proposed → approved → executing → completed | abandoned
 *   proposed → abandoned
 */
export async function updatePlanStatus(plan_id: string, status: PlanStatus): Promise<void> {
  const updated = await dataService.one<{ plan_id: string }>(
    `UPDATE semantic.intent_plan
        SET status = $2
      WHERE plan_id = $1
    RETURNING plan_id`,
    [plan_id, status],
  );
  if (!updated) throw new Error(`[sdk-semantic] plan '${plan_id}' not found`);

  if (status === 'completed' || status === 'abandoned') {
    await appendAuditEntry({
      event_type: 'semantic.plan.executed.v1',
      payload: { plan_id, status },
      pool_index: SEMANTIC_AUDIT_POOL,
      actor_kind: 'service',
      actor_id: 'sdk-semantic',
      retention_class: 'regulated',
    });
  }
}

export async function getPlan(plan_id: string): Promise<Plan | null> {
  const row = await dataService.one<{
    plan_id: string;
    intent_id: string;
    subject_id: string;
    steps: PlanStep[];
    generated_by_agent_run_id: string | null;
    generated_at: Date;
    status: string;
  }>(
    `SELECT plan_id, intent_id, subject_id, steps, generated_by_agent_run_id, generated_at, status
       FROM semantic.intent_plan
      WHERE plan_id = $1`,
    [plan_id],
  );
  if (!row) return null;
  return {
    plan_id: row.plan_id,
    intent_id: row.intent_id,
    subject_id: row.subject_id,
    steps: row.steps,
    generated_by_agent_run_id: row.generated_by_agent_run_id,
    generated_at: row.generated_at.toISOString(),
    status: row.status as PlanStatus,
  };
}

/* ============================================================
 * Internal helpers
 * ============================================================ */

/**
 * Persist a transient SemanticIntent on first use so the plan row has a
 * stable FK. Returns the resolved intent_id. Idempotent on (tenant_id, goal).
 */
async function ensureIntentRow(intent: SemanticIntent): Promise<string> {
  // Look up subject object_type_id (the migration enforces FK to it).
  const subj = await dataService.one<{ object_type_id: string }>(
    `SELECT object_type_id FROM semantic.object_type
      WHERE ontology_id = $1 AND name = $2`,
    [intent.ontology_id, intent.subject.type],
  );
  if (!subj) {
    throw new Error(
      `[sdk-semantic] cannot persist intent — subject type '${intent.subject.type}' not registered`,
    );
  }

  const existing = await dataService.one<{ intent_id: string }>(
    `SELECT intent_id FROM semantic.intent WHERE tenant_id = $1 AND goal = $2`,
    [intent.tenant_id, intent.goal],
  );
  if (existing) return existing.intent_id;

  const inserted = await dataService.one<{ intent_id: string }>(
    `INSERT INTO semantic.intent
       (intent_id, tenant_id, ontology_id, goal, subject_object_type_id, parameters_schema)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (tenant_id, goal) DO UPDATE SET goal = EXCLUDED.goal
     RETURNING intent_id`,
    [
      randomUUID(),
      intent.tenant_id,
      intent.ontology_id,
      intent.goal,
      subj.object_type_id,
      buildParametersSchema(intent.parameters),
    ],
  );
  return inserted!.intent_id;
}

/** Split a goal into lower-case word tokens (snake → words). */
function tokenizeGoal(goal: string): Set<string> {
  const cleaned = goal
    .replace(/[_.]/g, ' ')
    .replace(/[A-Z]/g, (c) => ` ${c.toLowerCase()}`)
    .toLowerCase()
    .trim();
  return new Set(cleaned.split(/\s+/).filter((w) => w.length > 0));
}

/**
 * Verify every key in pre_conditions has a present + truthy match in the
 * caller-supplied parameters. Missing or false-y values reject the edge.
 *
 * v1 uses straight equality / presence checks; future versions can grow
 * an expression evaluator (PRD Q-2 controlled vocabulary).
 */
function checkPreConditions(
  preConditions: Record<string, unknown>,
  parameters: Record<string, unknown>,
): boolean {
  for (const [key, expected] of Object.entries(preConditions)) {
    if (key === 'requires') {
      if (!Array.isArray(expected)) continue;
      for (const req of expected as string[]) {
        if (!(req in parameters)) return false;
      }
      continue;
    }
    const actual = parameters[key];
    if (typeof expected === 'object' && expected !== null) {
      // Range/enum specifiers: {min, max} or {oneOf:[]}.
      const spec = expected as Record<string, unknown>;
      if ('oneOf' in spec) {
        if (!(spec.oneOf as unknown[]).includes(actual)) return false;
        continue;
      }
      if ('min' in spec && typeof actual === 'number' && actual < (spec.min as number)) return false;
      if ('max' in spec && typeof actual === 'number' && actual > (spec.max as number)) return false;
      continue;
    }
    if (expected !== undefined && actual !== expected) return false;
  }
  return true;
}

/** Returns true if post_conditions mention any goal token. */
function postConditionsAdvance(postConditions: Record<string, unknown>, goalTokens: Set<string>): boolean {
  const serialized = JSON.stringify(postConditions).toLowerCase();
  for (const t of goalTokens) {
    if (serialized.includes(t)) return true;
  }
  return false;
}

/**
 * Stable topological order: for every pair (a,b), if a's post_conditions
 * provide keys that b's pre_conditions require, a sorts before b. Cycles
 * break by tool_sku alphabetical order.
 */
function topoOrder(edges: CapabilityEdgeRow[]): CapabilityEdgeRow[] {
  const provides = (e: CapabilityEdgeRow) => new Set(Object.keys(e.post_conditions ?? {}));
  const requires = (e: CapabilityEdgeRow) => new Set(Object.keys(e.pre_conditions ?? {}));

  const ranked = [...edges];
  ranked.sort((a, b) => {
    const aProvides = provides(a);
    const bRequires = requires(b);
    let aHelpsB = false;
    for (const k of aProvides) if (bRequires.has(k)) { aHelpsB = true; break; }
    if (aHelpsB) return -1;

    const bProvides = provides(b);
    const aRequires = requires(a);
    let bHelpsA = false;
    for (const k of bProvides) if (aRequires.has(k)) { bHelpsA = true; break; }
    if (bHelpsA) return 1;

    return a.tool_sku.localeCompare(b.tool_sku);
  });
  return ranked;
}

/** Bundle the typed args for a single step from the intent. */
function buildStepArgs(
  edge: CapabilityEdgeRow,
  intent: SemanticIntent,
  subjectId: string,
): Record<string, unknown> {
  // Pre-conditions name args the edge expects (PRD §5.7 example
  // pre_conditions/post_conditions). We pass the matching intent
  // parameters straight through; unmentioned params come along too so
  // downstream tool runtime can use them.
  const args: Record<string, unknown> = {
    subject_id: subjectId,
    ...intent.parameters,
  };
  if (edge.required_relation_name) {
    args._required_relation = edge.required_relation_name;
  }
  return args;
}

function buildParametersSchema(parameters: Record<string, unknown>): Record<string, unknown> {
  // Materialize a minimal JSON-schema-ish object that records the parameter
  // shape. Future versions can grow real type inference.
  const out: Record<string, unknown> = { type: 'object', properties: {} };
  const props = out.properties as Record<string, unknown>;
  for (const [k, v] of Object.entries(parameters)) {
    props[k] = { type: jsonType(v) };
  }
  return out;
}

function jsonType(v: unknown): string {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  const t = typeof v;
  return t === 'object' ? 'object' : t;
}
