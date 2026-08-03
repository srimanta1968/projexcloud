import { dataService } from '@projexlight/db-runtime';

/**
 * Survivorship rules (P16 · EP-382).
 *
 * An ORDERED list of criteria per attribute — not a set of weights. Order is the rule:
 * "a verified value beats an unverified one, and only if that ties does origin matter"
 * cannot be expressed as weights without inventing magic numbers, and weights make a loss
 * unexplainable ("it scored 0.62") where an ordered list makes it a sentence ("it lost on
 * verification_state").
 *
 * Resolution is tenant-first, then platform, and the platform row is never edited in
 * place, so "what does the platform say" stays answerable after a tenant overrides it.
 */

export type CriterionName = 'verification_state' | 'origin_class' | 'confidence' | 'recency';

export interface SurvivorshipCriterion {
  criterion: CriterionName;
  /** For enumerated criteria — best first. */
  order?: string[];
  /** For numeric criteria. Defaults to 'desc' (higher/newer wins). */
  direction?: 'asc' | 'desc';
}

export interface SurvivorshipRuleSet {
  rule_set_id: string | null;
  tenant_id: string | null;
  attribute: string;
  criteria: SurvivorshipCriterion[];
  /** Which layer answered — surfaced so a tenant can tell an override from the default. */
  source: 'tenant' | 'platform' | 'builtin';
  updated_at: string | null;
  updated_by: string | null;
}

const VALID_CRITERIA: CriterionName[] = [
  'verification_state',
  'origin_class',
  'confidence',
  'recency',
];

/**
 * The last-resort default, identical to the row migration 002 seeds. Kept in code as well
 * so resolution still works against a database where the seed has not run — the service
 * degrades to the documented behaviour instead of failing a read.
 */
export const BUILTIN_CRITERIA: SurvivorshipCriterion[] = [
  { criterion: 'verification_state', order: ['verified', 'unverified', 'rejected'] },
  {
    criterion: 'origin_class',
    order: ['human_verified', 'user_supplied', 'enrichment', 'import', 'inferred'],
  },
  { criterion: 'confidence', direction: 'desc' },
  { criterion: 'recency', direction: 'desc' },
];

interface RuleRow {
  rule_set_id: string;
  tenant_id: string | null;
  attribute: string;
  criteria: SurvivorshipCriterion[];
  updated_at: Date;
  updated_by: string | null;
}

function rowToRuleSet(r: RuleRow): SurvivorshipRuleSet {
  return {
    rule_set_id: r.rule_set_id,
    tenant_id: r.tenant_id,
    attribute: r.attribute,
    criteria: r.criteria,
    source: r.tenant_id ? 'tenant' : 'platform',
    updated_at: r.updated_at.toISOString(),
    updated_by: r.updated_by,
  };
}

/**
 * Reject a malformed rule set at write time rather than at projection time.
 *
 * A bad rule discovered during a projection produces a wrong winner that nobody notices;
 * discovered at PUT, it produces an error the author can act on immediately.
 */
export function validateCriteria(criteria: unknown): string[] {
  const errors: string[] = [];
  if (!Array.isArray(criteria)) return ['criteria must be an array'];
  if (criteria.length === 0) return ['criteria must contain at least one criterion'];

  const seen = new Set<string>();
  criteria.forEach((c, i) => {
    const o = c as Partial<SurvivorshipCriterion>;
    if (!o || typeof o !== 'object') {
      errors.push(`criteria[${i}] must be an object`);
      return;
    }
    if (!o.criterion || !VALID_CRITERIA.includes(o.criterion)) {
      errors.push(`criteria[${i}].criterion must be one of: ${VALID_CRITERIA.join(', ')}`);
      return;
    }
    // A repeated criterion is always a mistake: the second occurrence can never be
    // reached, so silently accepting it would leave the author believing it applies.
    if (seen.has(o.criterion)) {
      errors.push(`criteria[${i}] repeats '${o.criterion}' — the later one can never be reached`);
    }
    seen.add(o.criterion);

    if (o.criterion === 'verification_state' || o.criterion === 'origin_class') {
      if (!Array.isArray(o.order) || o.order.length === 0) {
        errors.push(`criteria[${i}] ('${o.criterion}') requires a non-empty 'order' array, best first`);
      } else if (new Set(o.order).size !== o.order.length) {
        errors.push(`criteria[${i}].order contains duplicates, so its precedence is ambiguous`);
      }
    }
    if (o.direction && o.direction !== 'asc' && o.direction !== 'desc') {
      errors.push(`criteria[${i}].direction must be 'asc' or 'desc'`);
    }
  });
  return errors;
}

/**
 * Tenant-first, platform fallback, builtin last (AC2).
 *
 * An attribute-specific rule set beats the catch-all '*' at the SAME layer, but a tenant's
 * '*' still beats the platform's specific rule — the tenant has deliberately stated a
 * house policy, and letting a platform default override it would make the override
 * unreliable in exactly the cases it was written for.
 */
export async function resolveSurvivorshipRules(input: {
  tenant_id: string;
  attribute: string;
}): Promise<SurvivorshipRuleSet> {
  const row = await dataService.one<RuleRow>(
    `SELECT rule_set_id::text, tenant_id::text, attribute, criteria, updated_at, updated_by
       FROM projection.survivorship_rule
      WHERE (tenant_id = $1::uuid OR tenant_id IS NULL)
        AND attribute IN ($2, '*')
      ORDER BY (tenant_id IS NOT NULL) DESC,
               (attribute = $2) DESC
      LIMIT 1`,
    [input.tenant_id, input.attribute],
  );
  if (row) return rowToRuleSet(row);

  return {
    rule_set_id: null,
    tenant_id: null,
    attribute: '*',
    criteria: BUILTIN_CRITERIA,
    source: 'builtin',
    updated_at: null,
    updated_by: null,
  };
}

export async function listSurvivorshipRules(tenant_id: string): Promise<SurvivorshipRuleSet[]> {
  const res = await dataService.query<RuleRow>(
    `SELECT rule_set_id::text, tenant_id::text, attribute, criteria, updated_at, updated_by
       FROM projection.survivorship_rule
      WHERE tenant_id = $1::uuid OR tenant_id IS NULL
      ORDER BY (tenant_id IS NOT NULL) DESC, attribute`,
    [tenant_id],
  );
  return res.rows.map(rowToRuleSet);
}

/**
 * Upsert a TENANT rule set. The platform row is deliberately unreachable from here — a
 * tenant editing the shared default would change every other tenant's precedence.
 */
export async function putSurvivorshipRules(input: {
  tenant_id: string;
  attribute?: string;
  criteria: SurvivorshipCriterion[];
  updated_by?: string;
}): Promise<SurvivorshipRuleSet> {
  const errors = validateCriteria(input.criteria);
  if (errors.length) {
    throw new Error(`[sdk-projection] invalid survivorship criteria: ${errors.join('; ')}`);
  }
  const attribute = input.attribute?.trim() || '*';

  const row = await dataService.one<RuleRow>(
    `INSERT INTO projection.survivorship_rule (tenant_id, attribute, criteria, updated_by)
     VALUES ($1::uuid, $2, $3::jsonb, $4)
     ON CONFLICT (tenant_id, attribute) WHERE tenant_id IS NOT NULL
       DO UPDATE SET criteria = EXCLUDED.criteria,
                     updated_at = now(),
                     updated_by = EXCLUDED.updated_by
     RETURNING rule_set_id::text, tenant_id::text, attribute, criteria, updated_at, updated_by`,
    [input.tenant_id, attribute, JSON.stringify(input.criteria), input.updated_by ?? null],
  );
  if (!row) throw new Error('[sdk-projection] survivorship rule upsert failed');
  return rowToRuleSet(row);
}

/** Remove a tenant override, falling the attribute back to the platform default. */
export async function deleteSurvivorshipRules(input: {
  tenant_id: string;
  attribute?: string;
}): Promise<boolean> {
  const res = await dataService.query(
    `DELETE FROM projection.survivorship_rule
      WHERE tenant_id = $1::uuid AND attribute = $2`,
    [input.tenant_id, input.attribute?.trim() || '*'],
  );
  return (res.rowCount ?? 0) > 0;
}
