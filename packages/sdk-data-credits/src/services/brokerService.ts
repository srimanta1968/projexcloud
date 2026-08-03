import { dataService } from '@projexlight/db-runtime';

/**
 * Resolving an OUTCOME to a vendor, and hiding that it happened.
 *
 * A tenant asks for "validate.phone". This file picks who serves it, in what order,
 * what to do when one falls over, and returns an answer that contains no trace of
 * any of that. The hiding is not politeness — it is the product: a tenant that
 * learns which vendor answered starts building on that vendor, and the day it is
 * replaced their integration breaks along with the abstraction.
 *
 * Everything that reaches a vendor goes through a registered hook. There are NO
 * DEFAULTS, deliberately:
 *
 *   * a default invoker returning "no match" would make an unwired provider
 *     indistinguishable from a number that genuinely is not real — the tenant would
 *     be told "not found" about a lookup nobody performed;
 *   * a default secret resolver returning an empty credential would make the call
 *     anyway and fail at the vendor with something unreadable.
 *
 * Unwired therefore produces a TECHNICAL_FAILURE that NAMES the gap, which is free
 * to the tenant (see reservationService) and loud to us.
 */

export type SettlementOutcome = 'MATCHED' | 'NO_MATCH' | 'TECHNICAL_FAILURE' | 'CACHE_HIT';
export type ProviderHealth = 'HEALTHY' | 'DEGRADED' | 'UNAVAILABLE';

export interface CapabilityRow {
  capability_id: string;
  tenant_id: string | null;
  key: string;
  outcome_label: string;
  description: string | null;
  credit_price: string;
  category: string | null;
  is_active: boolean;
}

/** What a tenant is allowed to see about a capability: the outcome and the price. */
export interface CapabilityView {
  key: string;
  outcome_label: string;
  description: string | null;
  credit_price: number;
  category: string | null;
}

export class UnknownCapability extends Error {
  readonly code = 'CAPABILITY_NOT_FOUND';
  constructor(key: string) {
    super(`no capability '${key}' is available to this tenant`);
    this.name = 'UnknownCapability';
  }
}

const CAPABILITY_COLS = `capability_id, tenant_id, key, outcome_label, description,
       credit_price::text AS credit_price, category, is_active`;

/**
 * The tenant's row if they have one, otherwise the platform default.
 *
 * ORDER BY tenant_id NULLS LAST is the whole resolution: a negotiated price beats
 * the list price, and there is at most one of each by unique index.
 */
export async function resolveCapability(tenant_id: string, key: string): Promise<CapabilityRow> {
  const row = await dataService.one<CapabilityRow>(
    `SELECT ${CAPABILITY_COLS}
       FROM data_credits.capability
      WHERE key = $2 AND is_active
        AND (tenant_id = $1 OR tenant_id IS NULL)
      ORDER BY tenant_id NULLS LAST
      LIMIT 1`,
    [tenant_id, key],
  );
  if (!row) throw new UnknownCapability(key);
  return row;
}

/** The catalog as a tenant may see it — outcome and price, nothing else. */
export async function listCapabilities(tenant_id: string): Promise<CapabilityView[]> {
  const rows = await dataService.rows<CapabilityRow>(
    `SELECT DISTINCT ON (key) ${CAPABILITY_COLS}
       FROM data_credits.capability
      WHERE is_active AND (tenant_id = $1 OR tenant_id IS NULL)
      ORDER BY key, tenant_id NULLS LAST`,
    [tenant_id],
  );
  return rows.map(toCapabilityView);
}

export function toCapabilityView(row: CapabilityRow): CapabilityView {
  // Built by naming fields rather than by deleting them from a spread: a column
  // added to the table later must not appear here by default. That is the
  // difference between a boundary and a habit.
  return {
    key: row.key,
    outcome_label: row.outcome_label,
    description: row.description,
    credit_price: Number(row.credit_price),
    category: row.category,
  };
}

/* ------------------------------------------------------------- the hooks */

export interface ProviderCallInput {
  /** The vendor this call is for. Never leaves this module. */
  provider_key: string;
  /** The credential material resolved from the binding's secret_ref. */
  credential: unknown;
  capability_key: string;
  subject: unknown;
  tenant_id: string;
}

export interface ProviderCallResult {
  /** MATCHED with a result, or NO_MATCH. A thrown error is a TECHNICAL_FAILURE. */
  matched: boolean;
  result?: unknown;
  /** What the call really cost us, in micros. Internal-only. */
  true_cost_micros?: number;
}

export type ProviderInvoker = (input: ProviderCallInput) => Promise<ProviderCallResult>;
export type SecretResolver = (secret_ref: string) => Promise<unknown>;

const invokers = new Map<string, ProviderInvoker>();
let secretResolver: SecretResolver | null = null;

/**
 * Wire a real vendor. Registered per provider_key so an adapter can be added or
 * removed without touching the chain in the database.
 */
export function registerProviderInvoker(provider_key: string, fn: ProviderInvoker): void {
  invokers.set(provider_key, fn);
}

export function clearProviderInvokers(): void {
  invokers.clear();
}

/** Resolve a secret_ref through sdk-secrets. No default — see the file header. */
export function setSecretResolver(fn: SecretResolver | null): void {
  secretResolver = fn;
}

export function hasSecretResolver(): boolean {
  return secretResolver !== null;
}

/* ------------------------------------------------------- the chain itself */

interface BindingRow {
  binding_id: string;
  provider_key: string;
  secret_ref: string;
  priority: number;
  health_state: ProviderHealth;
  consecutive_failures: number;
}

/**
 * How many consecutive failures take a provider out of the chain.
 *
 * Not a constant pulled from thin air: one failure is a bad request, two is
 * probably still noise, and a provider that has failed three times in a row is
 * either down or misconfigured, at which point continuing to try it first spends
 * the tenant's latency budget on a vendor that will not answer. It resets to zero
 * on the first success, so a blip does not exile anybody.
 */
const FAILURES_BEFORE_UNAVAILABLE = 3;

/**
 * How long an UNAVAILABLE provider sits out before it is tried again, LAST.
 *
 * Without this the chain only ever shrinks: three failures in a row is a blip a
 * vendor recovers from in minutes, but a provider that is never tried again can
 * never demonstrate that it has, so every outage permanently costs a link — until
 * the capability has no providers left and fails for everybody. Re-admitting it at
 * the BACK of the chain is what makes the retry free: a healthy provider still
 * answers first, and the probe only costs anything when everybody else has already
 * failed.
 */
const UNAVAILABLE_COOLDOWN = '5 minutes';

export async function loadChain(capability_id: string): Promise<BindingRow[]> {
  return dataService.rows<BindingRow>(
    `SELECT binding_id, provider_key, secret_ref, priority, health_state, consecutive_failures
       FROM data_credits.provider_binding
      WHERE capability_id = $1 AND is_active
        AND (health_state <> 'UNAVAILABLE'
             OR health_checked_at IS NULL
             OR health_checked_at < now() - interval '${UNAVAILABLE_COOLDOWN}')
      ORDER BY (health_state = 'HEALTHY') DESC,
               (health_state = 'DEGRADED') DESC,
               priority ASC, binding_id ASC`,
    [capability_id],
  );
}

export interface ExecuteInput {
  tenant_id: string;
  request_id: string;
  capability: CapabilityRow;
  subject: unknown;
}

/** What the broker returns INTERNALLY. Only `outcome` and `result` may be shown. */
export interface BrokerExecution {
  outcome: SettlementOutcome;
  result: unknown | null;
  /** Internal trace: which binding, in what order, how it went. Never returned to a tenant. */
  attempts: Array<{
    binding_id: string;
    provider_key: string;
    attempt_no: number;
    outcome: SettlementOutcome;
    latency_ms: number;
    true_cost_micros: number;
    error_code: string | null;
  }>;
}

/**
 * Walk the chain until somebody answers.
 *
 * A NO_MATCH does NOT stop the walk — the next provider may hold the record the
 * first one lacks, and stopping at the first empty answer would quietly turn a
 * multi-provider chain into a single-provider one. Only a MATCH stops it.
 *
 * The final outcome distinguishes "everybody looked and nobody has it" (NO_MATCH)
 * from "nobody managed to look" (TECHNICAL_FAILURE). Collapsing those two is how a
 * total outage gets reported to a tenant as "no results found".
 */
export async function executeThroughChain(input: ExecuteInput): Promise<BrokerExecution> {
  const chain = await loadChain(input.capability.capability_id);
  const attempts: BrokerExecution['attempts'] = [];

  if (chain.length === 0) {
    // No provider at all is a failure of ours, not an answer about the subject.
    return { outcome: 'TECHNICAL_FAILURE', result: null, attempts };
  }

  let sawNoMatch = false;
  let matched: unknown | null = null;

  for (const binding of chain) {
    const attempt_no = attempts.length + 1;
    const startedAt = Date.now();
    let outcome: SettlementOutcome = 'TECHNICAL_FAILURE';
    let error_code: string | null = null;
    let true_cost_micros = 0;

    try {
      const invoker = invokers.get(binding.provider_key);
      if (!invoker) {
        // Named, not swallowed: an unwired adapter must never look like a no-match.
        error_code = 'PROVIDER_NOT_WIRED';
      } else if (!secretResolver) {
        error_code = 'SECRET_RESOLVER_UNWIRED';
      } else {
        const credential = await secretResolver(binding.secret_ref);
        const res = await invoker({
          provider_key: binding.provider_key,
          credential,
          capability_key: input.capability.key,
          subject: input.subject,
          tenant_id: input.tenant_id,
        });
        true_cost_micros = Math.max(0, Math.round(res.true_cost_micros ?? 0));
        if (res.matched) {
          outcome = 'MATCHED';
          matched = res.result ?? null;
        } else {
          outcome = 'NO_MATCH';
          sawNoMatch = true;
        }
      }
    } catch (err) {
      error_code = (err as { code?: string }).code ?? 'PROVIDER_ERROR';
    }

    attempts.push({
      binding_id: binding.binding_id,
      provider_key: binding.provider_key,
      attempt_no,
      outcome,
      latency_ms: Date.now() - startedAt,
      true_cost_micros,
      error_code,
    });

    await recordHealth(binding, outcome);
    if (outcome === 'MATCHED') break;
  }

  await recordAttempts(input.request_id, attempts);

  if (matched !== null || attempts.some((a) => a.outcome === 'MATCHED')) {
    return { outcome: 'MATCHED', result: matched, attempts };
  }
  return { outcome: sawNoMatch ? 'NO_MATCH' : 'TECHNICAL_FAILURE', result: null, attempts };
}

async function recordAttempts(
  request_id: string,
  attempts: BrokerExecution['attempts'],
): Promise<void> {
  if (attempts.length === 0) return;
  for (const a of attempts) {
    await dataService.query(
      `INSERT INTO data_credits.provider_attempt
          (request_id, binding_id, attempt_no, outcome, latency_ms, true_cost_micros, error_code)
       VALUES ($1, $2, $3, $4::data_credits.settlement_outcome, $5, $6, $7)
       ON CONFLICT (request_id, attempt_no) DO NOTHING`,
      [request_id, a.binding_id, a.attempt_no, a.outcome, a.latency_ms, a.true_cost_micros, a.error_code],
    );
  }
}

/**
 * Health is an observation, updated from what just happened.
 *
 * A success resets the counter and restores HEALTHY: a provider that answers is
 * healthy regardless of what it did an hour ago, and leaving it DEGRADED forever
 * would slowly empty the chain of everybody who ever had a bad minute.
 */
async function recordHealth(binding: BindingRow, outcome: SettlementOutcome): Promise<void> {
  if (outcome === 'TECHNICAL_FAILURE') {
    const failures = binding.consecutive_failures + 1;
    const state: ProviderHealth = failures >= FAILURES_BEFORE_UNAVAILABLE ? 'UNAVAILABLE' : 'DEGRADED';
    await dataService.query(
      `UPDATE data_credits.provider_binding
          SET consecutive_failures = $2, health_state = $3::data_credits.provider_health,
              health_checked_at = now()
        WHERE binding_id = $1`,
      [binding.binding_id, failures, state],
    );
    return;
  }
  await dataService.query(
    `UPDATE data_credits.provider_binding
        SET consecutive_failures = 0, health_state = 'HEALTHY', health_checked_at = now()
      WHERE binding_id = $1`,
    [binding.binding_id],
  );
}
