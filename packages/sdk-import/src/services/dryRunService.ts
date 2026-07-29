import { dataService } from '@projexlight/db-runtime';
import {
  type DryRunResult,
  type FieldMapping,
  type GovernanceVerdict,
  type TransformPlan,
} from '../models/import.model';
import { applyTransforms } from './transformService';
import { confirmedMappings } from './mappingAssistantService';

/**
 * sdk-import zero-write dry run (P16 · EP-375 · PCF-02-3).
 *
 * Shows what a commit WOULD do — new rows, exact links, review cases, related
 * entities, invalid rows — and the governance verdicts, without writing anything.
 *
 * "Without writing anything" is ENFORCED, then PROVEN, then ROLLED BACK:
 *
 *   1. ENFORCED — the simulation runs in a `SET TRANSACTION READ ONLY` block, so a
 *      write on that connection raises 25006 immediately. Making it impossible
 *      beats detecting it afterwards: a convention ("we just don't write here")
 *      survives exactly until someone adds a helpful audit line.
 *   2. PROVEN — it then asks `pg_current_xact_id_if_assigned()`. An xid is handed
 *      out the moment a transaction writes to the WAL, so a non-null answer means
 *      something got through and the dry run fails loudly.
 *   3. ROLLED BACK — unconditionally, so even a correct run leaves no trace.
 *
 * Hooks receive a read-only, transaction-scoped `query` so a composed service can
 * look things up on the SAME protected connection.
 *
 * KNOWN LIMIT, stated rather than papered over: a hook that opens its OWN pooled
 * connection and writes there is outside both the read-only block and the xid
 * check — no in-process mechanism can prevent that. The hook contract is
 * read-only, and hooks that need to read should use the provided `query`. The
 * separate `notifications_dispatched` counter exists for the same reason: to
 * MEASURE what a composed flow did instead of assuming it behaved.
 *
 * One more distinction worth being precise about: the SIMULATION writes nothing.
 * Recording afterwards that a dry run happened is a separate, deliberate write by
 * the caller, outside the proven region.
 */

export interface DryRunInput {
  tenant_id: string;
  run_id: string;
  rows: Array<Record<string, string>>;
  field_map: Record<string, FieldMapping>;
  plan: TransformPlan;
  /** Attestation covering the source. Its absence is a governance failure, not a crash. */
  attestation_id?: string | null;
}

/** Raised when the simulation touched the database. A bug, surfaced immediately. */
export class DryRunWroteError extends Error {
  readonly status = 500;
  readonly code = 'DRY_RUN_WROTE';
  constructor(public xid: string) {
    super(
      `[sdk-import] the dry run acquired transaction id ${xid} — it wrote to the database. A dry run must have no side effects.`,
    );
    this.name = 'DryRunWroteError';
  }
}

/* ------------------------------------------------------------------ hooks */

/** Estimated match strength for one incoming row against existing records. */
export type MatchBand = 'exact' | 'strong' | 'review' | 'none';

/**
 * Read-only, transaction-scoped query handed to hooks. Using it keeps a lookup on
 * the protected connection, where an accidental write is refused outright.
 */
export type ReadOnlyQuery = <R extends Record<string, unknown>>(
  sql: string,
  params?: unknown[],
) => Promise<{ rows: R[] }>;

export interface HookContext {
  tenant_id: string;
  query: ReadOnlyQuery;
}

export type IdentityResolver = (
  candidate: Record<string, string | null>,
  ctx: HookContext,
) => Promise<{ band: MatchBand; matched_id?: string | null }>;

/**
 * Default: everything is NEW. With no resolver wired the dry run must not claim
 * matches it cannot see — over-reporting "exact link" would tell an importer their
 * data is already known when it is not, and they would skip the import.
 */
const defaultResolver: IdentityResolver = async () => ({ band: 'none' });

let identityResolver: IdentityResolver = defaultResolver;

/** Wire sdk-identity-resolver (POST /api/resolver/resolve) at app boot. */
export function setIdentityResolver(fn: IdentityResolver | null): void {
  identityResolver = fn ?? defaultResolver;
}

export type GeoCanonicalizer = (
  address: Record<string, string | null>,
  ctx: HookContext,
) => Promise<{ candidates: number; canonical?: Record<string, unknown> | null }>;

/** Default: one candidate, i.e. take the address as given. */
const defaultGeo: GeoCanonicalizer = async () => ({ candidates: 1 });

let geoCanonicalizer: GeoCanonicalizer = defaultGeo;

/** Wire sdk-geo (POST /api/geo/canonicalize) at app boot. */
export function setGeoCanonicalizer(fn: GeoCanonicalizer | null): void {
  geoCanonicalizer = fn ?? defaultGeo;
}

/**
 * Notification dispatch counter. A dry run must send nothing; this exists so the
 * claim is measured rather than assumed. sdk-import never dispatches — the counter
 * proves that a composed flow did not either.
 */
let notificationsDuringDryRun = 0;

/** Called by any composed service that would dispatch during a run. */
export function noteNotificationDispatched(): void {
  notificationsDuringDryRun += 1;
}

/* --------------------------------------------------------------- governance */

function governanceChecks(input: DryRunInput, reviewRows: number): GovernanceVerdict[] {
  const confirmed = confirmedMappings(input.field_map);
  const verdicts: GovernanceVerdict[] = [];

  verdicts.push({
    check: 'attestation_signed',
    passed: Boolean(input.attestation_id),
    detail: input.attestation_id
      ? `covered by attestation ${input.attestation_id}`
      : 'no source-rights attestation is attached — the commit will refuse',
  });

  verdicts.push({
    check: 'mapping_confirmed',
    passed: confirmed.length > 0,
    detail:
      confirmed.length > 0
        ? `${confirmed.length} column(s) confirmed by a human`
        : 'no mapping has been confirmed — nothing would land',
  });

  const unreviewed = Object.values(input.field_map).filter(
    (m) => !m.confirmed && m.target !== 'unmapped',
  );
  verdicts.push({
    check: 'no_unconfirmed_suggestions_applied',
    passed: true,
    detail:
      unreviewed.length > 0
        ? `${unreviewed.length} suggested mapping(s) remain unconfirmed and will be ignored by the commit`
        : 'every suggested mapping was reviewed',
  });

  const sensitive = confirmed.filter((m) => m.tokenize_at_ingress);
  verdicts.push({
    check: 'sensitive_columns_tokenized',
    passed: true,
    detail:
      sensitive.length > 0
        ? `${sensitive.length} column(s) will be tokenized at trusted ingress: ${sensitive.map((m) => m.source_column).join(', ')}`
        : 'no sensitive columns in the confirmed mapping',
  });

  verdicts.push({
    check: 'review_backlog',
    passed: reviewRows === 0,
    detail:
      reviewRows === 0
        ? 'no rows need a human before commit'
        : `${reviewRows} row(s) need a human decision before they can land`,
  });

  return verdicts;
}

/* ------------------------------------------------------------------ run */

/**
 * Simulate the commit.
 *
 * Uses the SAME transform code path the commit uses, so the counts describe what
 * will actually happen rather than a parallel estimate that drifts.
 */
export async function runDryRun(input: DryRunInput): Promise<DryRunResult> {
  notificationsDuringDryRun = 0;

  let new_count = 0;
  let exact_link_count = 0;
  let review_case_count = 0;
  let related_entity_count = 0;
  let invalid_count = 0;

  const { xidAssigned } = await dataService.tx(async (q) => {
    // Enforcement first: from here on, any write on this connection raises 25006.
    await q('SET TRANSACTION READ ONLY');
    const readOnlyQuery: ReadOnlyQuery = async (sql, params) => {
      const r = await q(sql as string, params ?? []);
      return { rows: r.rows as never[] };
    };
    const hookCtx: HookContext = { tenant_id: input.tenant_id, query: readOnlyQuery };

    for (const row of input.rows) {
      const transformed = applyTransforms(row, input.field_map, input.plan);

      if (transformed.invalid.length > 0) {
        invalid_count += 1;
        continue;
      }

      const candidate: Record<string, string | null> = {};
      for (const v of transformed.values) candidate[v.target] = v.value;

      const placeValues = transformed.values.filter((v) => v.target.startsWith('place.'));
      if (placeValues.length > 0) {
        const geo = await geoCanonicalizer(
          Object.fromEntries(placeValues.map((v) => [v.target, v.value])),
          hookCtx,
        );
        // A place is a related entity in its own right — that is why it is counted
        // separately rather than folded into the subject's row count.
        related_entity_count += 1;
        if (geo.candidates > 1) {
          transformed.review.push(
            `the address matched ${geo.candidates} candidates — confirm which one before commit`,
          );
        }
      }

      const match = await identityResolver(candidate, hookCtx);
      if (transformed.review.length > 0 || match.band === 'review') {
        review_case_count += 1;
      } else if (match.band === 'exact') {
        exact_link_count += 1;
      } else {
        new_count += 1;
      }
    }

    // THE PROOF. An xid is assigned the moment a transaction writes; a read-only
    // transaction never gets one. Asked inside the same transaction, before the
    // rollback, so it describes exactly the work above.
    const res = await q<{ xid: string | null }>(
      'SELECT pg_current_xact_id_if_assigned()::text AS xid',
    );
    const xid = res.rows[0]?.xid ?? null;

    // Roll back unconditionally: even a correct dry run should leave no trace, and
    // an incorrect one must not be allowed to commit its accident.
    throw new DryRunComplete(xid);
  }).catch((err: unknown) => {
    if (err instanceof DryRunComplete) return { xidAssigned: err.xid };
    throw err;
  });

  if (xidAssigned) throw new DryRunWroteError(xidAssigned);

  const result: DryRunResult = {
    new_count,
    exact_link_count,
    review_case_count,
    related_entity_count,
    invalid_count,
    governance: governanceChecks(input, review_case_count),
    writes_observed: 0,
    notifications_dispatched: notificationsDuringDryRun,
    ran_at: new Date().toISOString(),
  };
  return result;
}

/**
 * Control-flow signal, not a failure: throwing is how the transaction helper is
 * told to roll back after a successful simulation.
 */
class DryRunComplete extends Error {
  constructor(public xid: string | null) {
    super('dry run complete — rolling back');
    this.name = 'DryRunComplete';
  }
}
