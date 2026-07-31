import { dataService } from '@projexlight/db-runtime';
import { setLoadProvider, type LoadProvider } from './eligibilityService';

/**
 * How much somebody is already holding, and whether they may be handed more.
 *
 * TWO RULES THIS ENCODES, BOTH LEARNED THE HARD WAY
 * --------------------------------------------------
 * 1. Load is MEASURED, never stored. A denormalised open_count drifts the moment
 *    a work item is closed by a path that forgot to decrement it, and the drift
 *    is invisible until somebody is either starved of work or buried in it. Every
 *    figure here is computed at the instant it is asked for.
 *
 * 2. A band absent from a policy is UNCAPPED, which is a different statement from
 *    capped at zero, and both must be expressible. Treating "not mentioned" as
 *    zero would silently freeze every band a tenant had not thought to list.
 *
 * The package stays vertical-neutral: it never names the table that holds work.
 * `makeQueryLoadProvider` takes the shape of that table as configuration, so the
 * gateway can point it at sdk-assignment's workload without sdk-coverage
 * depending on sdk-assignment — or on any vertical's idea of what work is.
 */

export interface CapacityPolicy {
  capacity_policy_id: string;
  tenant_id: string;
  persona_id: string | null;
  role_ref: string | null;
  max_concurrent_by_band: Record<string, number>;
  freeze_threshold: string | number;
  freeze_threshold_by_band: Record<string, number>;
  daily_cap: number | null;
  is_active: boolean;
}

const POLICY_COLUMNS = `capacity_policy_id, tenant_id, persona_id, role_ref,
       max_concurrent_by_band, freeze_threshold, freeze_threshold_by_band,
       daily_cap, is_active`;

export interface BandCapacity {
  band: string;
  /** null means this band is uncapped for this persona. */
  limit: number | null;
  load: number;
  /** null when uncapped — headroom is unbounded, not zero. */
  headroom: number | null;
  /** Fraction of the limit at which new work stops. */
  freeze_threshold: number;
  /** True when load has reached the freeze point and no more may be assigned. */
  frozen: boolean;
}

export interface PersonaCapacity {
  persona_id: string;
  /** False when no policy applies — uncapped, and eligible on capacity grounds. */
  has_policy: boolean;
  /** False when a policy applies but load could not be measured. */
  measured: boolean;
  bands: BandCapacity[];
  total_load: number;
  /** True when EVERY capped band is frozen — the persona can take nothing new. */
  fully_frozen: boolean;
}

/**
 * Effective policy per persona: a persona-scoped policy wins over a role-scoped
 * one. The schema already refuses a row naming both, so precedence is only ever
 * between two rows, and the more specific one is the one somebody wrote about
 * this person.
 */
export async function resolvePolicies(input: {
  tenant_id: string;
  persona_ids: string[];
  role_ref?: string;
}): Promise<Map<string, CapacityPolicy>> {
  if (input.persona_ids.length === 0) return new Map();

  const rows = await dataService.rows<CapacityPolicy>(
    `SELECT ${POLICY_COLUMNS}
       FROM coverage.capacity_policy
      WHERE tenant_id = $1 AND is_active
        AND (persona_id = ANY($2::uuid[]) OR ($3::text IS NOT NULL AND role_ref = $3))`,
    [input.tenant_id, input.persona_ids, input.role_ref ?? null],
  );

  const byPersona = new Map<string, CapacityPolicy>();
  const rolePolicy = rows.find((r) => r.role_ref !== null) ?? null;
  for (const persona_id of input.persona_ids) {
    const own = rows.find((r) => r.persona_id === persona_id);
    const effective = own ?? rolePolicy;
    if (effective) byPersona.set(persona_id, effective);
  }
  return byPersona;
}

function thresholdFor(policy: CapacityPolicy, band: string): number {
  const perBand = policy.freeze_threshold_by_band?.[band];
  const raw = typeof perBand === 'number' ? perBand : Number(policy.freeze_threshold);
  if (!Number.isFinite(raw) || raw <= 0) return 1;
  // Above 1.0 would mean "keep assigning past the limit", which is not a
  // threshold at all. Clamped rather than rejected: the policy is still usable.
  return Math.min(raw, 1);
}

/**
 * Evaluates capacity for a set of personas at an instant.
 *
 * `load` is supplied rather than fetched so the caller controls measurement —
 * findEligible already has the numbers from its own provider and must not pay
 * for them twice.
 */
export function evaluateCapacity(input: {
  persona_ids: string[];
  policies: Map<string, CapacityPolicy>;
  /** persona_id -> band -> open count. Absent persona = not measured. */
  load: Record<string, Record<string, number>>;
  /** Report on these bands even when the persona holds none. */
  bands?: string[];
}): PersonaCapacity[] {
  return input.persona_ids.map((persona_id) => {
    const policy = input.policies.get(persona_id);
    const measuredLoad = input.load[persona_id];
    const loadByBand = measuredLoad ?? {};
    const total_load = Object.values(loadByBand).reduce((sum, n) => sum + (Number(n) || 0), 0);

    if (!policy) {
      // No policy genuinely means no limit. Reporting frozen here would exclude
      // everybody a tenant has not written a policy for.
      return {
        persona_id,
        has_policy: false,
        measured: measuredLoad !== undefined,
        bands: [],
        total_load,
        fully_frozen: false,
      };
    }

    const bandNames = new Set<string>([
      ...Object.keys(policy.max_concurrent_by_band ?? {}),
      ...Object.keys(loadByBand),
      ...(input.bands ?? []),
    ]);

    const bands: BandCapacity[] = [...bandNames].sort().map((band) => {
      const rawLimit = policy.max_concurrent_by_band?.[band];
      const limit = typeof rawLimit === 'number' ? rawLimit : null;
      const load = Number(loadByBand[band] ?? 0);
      const freeze_threshold = thresholdFor(policy, band);
      if (limit === null) {
        return { band, limit: null, load, headroom: null, freeze_threshold, frozen: false };
      }
      const freezeAt = limit * freeze_threshold;
      return {
        band,
        limit,
        load,
        headroom: Math.max(0, limit - load),
        freeze_threshold,
        // >= so a limit of 0 with any threshold is frozen at zero load, which is
        // what "capped at zero" has to mean.
        frozen: load >= freezeAt,
      };
    });

    const capped = bands.filter((b) => b.limit !== null);
    const dailyFrozen = policy.daily_cap !== null && total_load >= policy.daily_cap;

    return {
      persona_id,
      has_policy: true,
      measured: measuredLoad !== undefined,
      bands,
      total_load,
      // A persona with a policy that caps nothing is not "fully frozen" — there
      // is nothing to be frozen out of.
      fully_frozen: dailyFrozen || (capped.length > 0 && capped.every((b) => b.frozen)),
    };
  });
}

/** Measures load, resolves policy and evaluates headroom in one call. */
export async function getCapacity(input: {
  tenant_id: string;
  persona_ids: string[];
  role_ref?: string;
  bands?: string[];
  at?: Date;
  /** Defaults to whatever was wired via setLoadProvider. */
  loadProvider?: LoadProvider;
}): Promise<PersonaCapacity[]> {
  const at = (input.at ?? new Date()).toISOString();
  const policies = await resolvePolicies(input);
  const provider = input.loadProvider ?? currentProvider;
  const load = provider
    ? await provider({ tenant_id: input.tenant_id, persona_ids: input.persona_ids, at })
    : {};
  return evaluateCapacity({ persona_ids: input.persona_ids, policies, load, bands: input.bands });
}

/* ------------------------------------------------------- load provider */

let currentProvider: LoadProvider | null = null;

/**
 * Registers the provider with BOTH this service and the eligibility engine, so
 * the two can never disagree about how much somebody is holding. Wiring them
 * separately is how a routing decision starts contradicting the capacity screen.
 */
export function useLoadProvider(fn: LoadProvider | null): void {
  currentProvider = fn;
  setLoadProvider(fn);
}

export interface QueryLoadProviderConfig {
  /** Schema-qualified table holding open work, e.g. 'assignment.workload'. */
  table: string;
  personaColumn: string;
  tenantColumn: string;
  /** Column naming the priority band. Omit for a single implicit band. */
  bandColumn?: string;
  /** Band reported when bandColumn is absent. */
  defaultBand?: string;
  /** SQL predicate selecting OPEN work only, e.g. "status IN ('open','accepted')". */
  openPredicate: string;
}

/**
 * Builds a live LoadProvider over a caller-named table.
 *
 * Configuration rather than coupling: sdk-coverage must not import
 * sdk-assignment (that would make a workforce primitive depend on one consumer's
 * idea of work), but every consumer hand-rolling this query would guarantee they
 * drift. The gateway supplies the table shape once.
 *
 * `table`, the column names and `openPredicate` are interpolated, NOT bound —
 * they are identifiers and a SQL fragment, which parameters cannot express. They
 * must therefore come from application configuration and never from a request;
 * the identifier check below makes an accidental request-derived value fail loudly
 * rather than execute.
 */
export function makeQueryLoadProvider(config: QueryLoadProviderConfig): LoadProvider {
  const ident = /^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)?$/;
  for (const [name, value] of Object.entries({
    table: config.table,
    personaColumn: config.personaColumn,
    tenantColumn: config.tenantColumn,
    ...(config.bandColumn ? { bandColumn: config.bandColumn } : {}),
  })) {
    if (!ident.test(value)) {
      throw new Error(
        `[sdk-coverage] makeQueryLoadProvider: ${name} '${value}' is not a plain SQL identifier. ` +
          'These are interpolated into the query and must come from configuration, not from a request.',
      );
    }
  }

  const band = config.bandColumn ? config.bandColumn : `'${config.defaultBand ?? 'default'}'`;

  return async ({ tenant_id, persona_ids }) => {
    if (persona_ids.length === 0) return {};
    const rows = await dataService.rows<{ persona_id: string; band: string; open_count: string }>(
      `SELECT ${config.personaColumn} AS persona_id,
              ${band} AS band,
              COUNT(*) AS open_count
         FROM ${config.table}
        WHERE ${config.tenantColumn} = $1
          AND ${config.personaColumn} = ANY($2::uuid[])
          AND (${config.openPredicate})
        GROUP BY 1, 2`,
      [tenant_id, persona_ids],
    );

    const out: Record<string, Record<string, number>> = {};
    // Every persona asked about gets an entry, even with no open work — the
    // difference between "measured, zero" and "not measured" is what decides
    // whether they are eligible or excluded as CAPACITY_UNKNOWN.
    for (const persona_id of persona_ids) out[persona_id] = {};
    for (const row of rows) {
      out[row.persona_id] = out[row.persona_id] ?? {};
      out[row.persona_id][row.band] = Number(row.open_count);
    }
    return out;
  };
}

/* --------------------------------------------------------- policy CRUD */

export interface UpsertCapacityPolicyInput {
  tenant_id: string;
  persona_id?: string;
  role_ref?: string;
  max_concurrent_by_band?: Record<string, number>;
  freeze_threshold?: number;
  freeze_threshold_by_band?: Record<string, number>;
  daily_cap?: number | null;
}

export class CapacityPolicySubjectError extends Error {
  constructor() {
    super('A capacity policy names exactly one of persona_id or role_ref');
    this.name = 'CapacityPolicySubjectError';
  }
}

export async function upsertCapacityPolicy(
  input: UpsertCapacityPolicyInput,
): Promise<CapacityPolicy> {
  const hasPersona = Boolean(input.persona_id);
  const hasRole = Boolean(input.role_ref);
  // Checked here as well as by the schema so the caller gets a typed error rather
  // than a constraint name.
  if (hasPersona === hasRole) throw new CapacityPolicySubjectError();

  const conflict = hasPersona
    ? '(tenant_id, persona_id) WHERE persona_id IS NOT NULL AND is_active'
    : '(tenant_id, role_ref) WHERE role_ref IS NOT NULL AND is_active';

  const rows = await dataService.rows<CapacityPolicy>(
    `INSERT INTO coverage.capacity_policy
        (tenant_id, persona_id, role_ref, max_concurrent_by_band,
         freeze_threshold, freeze_threshold_by_band, daily_cap)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT ${conflict}
       DO UPDATE SET max_concurrent_by_band = EXCLUDED.max_concurrent_by_band,
                     freeze_threshold = EXCLUDED.freeze_threshold,
                     freeze_threshold_by_band = EXCLUDED.freeze_threshold_by_band,
                     daily_cap = EXCLUDED.daily_cap
     RETURNING ${POLICY_COLUMNS}`,
    [
      input.tenant_id,
      input.persona_id ?? null,
      input.role_ref ?? null,
      JSON.stringify(input.max_concurrent_by_band ?? {}),
      input.freeze_threshold ?? 1,
      JSON.stringify(input.freeze_threshold_by_band ?? {}),
      input.daily_cap ?? null,
    ],
  );
  return rows[0];
}

export async function listCapacityPolicies(tenant_id: string): Promise<CapacityPolicy[]> {
  return dataService.rows<CapacityPolicy>(
    `SELECT ${POLICY_COLUMNS} FROM coverage.capacity_policy
      WHERE tenant_id = $1 AND is_active ORDER BY created_at DESC`,
    [tenant_id],
  );
}
