import { dataService } from '@projexlight/db-runtime';
import {
  executeThroughChain,
  resolveCapability,
  toCapabilityView,
  type CapabilityRow,
  type CapabilityView,
  type SettlementOutcome,
} from './brokerService';

/**
 * estimate -> reserve -> execute -> settle.
 *
 * The promise this file keeps is narrow and absolute: a tenant pays for ANSWERS,
 * never for attempts. A vendor that found nothing, a vendor that fell over, and an
 * answer we already had in cache all settle to ZERO and hand the held credits back.
 * Only MATCHED costs anything, and it costs exactly what was quoted.
 *
 * The hold exists because the alternative is worse in both directions. Charging up
 * front means refunding for every no-match, and a refund is a promise to do
 * something later. Charging afterwards means a tenant can run a thousand concurrent
 * requests against a balance of five. Reserving is the only version where the
 * number in the account is true the whole time.
 *
 * The database enforces the settlement rules too (zero outcomes settle to zero,
 * never more than the quote, settle-once). That is deliberate duplication: these
 * are promises about somebody's money, and a promise kept only by the current
 * version of one function is not kept.
 */

// SettlementOutcome is owned by brokerService and re-exported from the package
// index there — exporting it from here too would make `export *` ambiguous and
// silently drop the name from the public surface.

export class InsufficientCredits extends Error {
  readonly code = 'INSUFFICIENT_CREDITS';
  constructor(needed: number, available: number) {
    super(`this request needs ${needed} credits and ${available} are available`);
    this.name = 'InsufficientCredits';
  }
}

export class NoCreditAccount extends Error {
  readonly code = 'CREDIT_ACCOUNT_NOT_FOUND';
  constructor() {
    super('this tenant has no credit account');
    this.name = 'NoCreditAccount';
  }
}

export class UnknownRequest extends Error {
  readonly code = 'CAPABILITY_REQUEST_NOT_FOUND';
  constructor(request_id: string) {
    super(`no capability request ${request_id}`);
    this.name = 'UnknownRequest';
  }
}

export class SettlementConflict extends Error {
  readonly code = 'SETTLEMENT_CONFLICT';
  constructor(message: string) {
    super(message);
    this.name = 'SettlementConflict';
  }
}

/* ------------------------------------------------------------- estimate */

export interface Estimate {
  capability: CapabilityView;
  credits: number;
  available: number;
  affordable: boolean;
}

export async function estimate(tenant_id: string, capability_key: string): Promise<Estimate> {
  const capability = await resolveCapability(tenant_id, capability_key);
  const account = await loadAccount(tenant_id);
  const credits = Number(capability.credit_price);
  const available = account ? Number(account.balance) - Number(account.reserved) : 0;
  return {
    capability: toCapabilityView(capability),
    credits,
    available,
    // Stated rather than left to the caller to compute, because the caller that
    // gets the comparison wrong finds out at the reserve, mid-flow.
    affordable: available >= credits,
  };
}

interface AccountRow {
  account_id: string;
  balance: string;
  reserved: string;
}

async function loadAccount(tenant_id: string): Promise<AccountRow | null> {
  return dataService.one<AccountRow>(
    `SELECT account_id, balance::text, reserved::text FROM data_credits.credit_account
      WHERE tenant_id = $1 AND is_active`,
    [tenant_id],
  );
}

/* -------------------------------------------------------------- reserve */

export interface ReserveInput {
  tenant_id: string;
  capability_key: string;
  subject_fingerprint: string;
  requested_by_persona_id?: string;
  role_ref?: string;
  metadata?: Record<string, unknown>;
  /** Set by budgetService when the requester's role needs an approval first. */
  requires_approval?: boolean;
}

export interface Reservation {
  request_id: string;
  reservation_id: string;
  capability: CapabilityView;
  estimated_credits: number;
  status: string;
}

/**
 * Create the request and hold the credits, in ONE transaction.
 *
 * Split across two, a crash between them leaves either a request nobody will ever
 * settle (holding nothing) or a hold with no request to release it — and the second
 * one silently shrinks the tenant's balance forever.
 */
export async function reserve(input: ReserveInput): Promise<Reservation> {
  const capability = await resolveCapability(input.tenant_id, input.capability_key);
  const price = Number(capability.credit_price);

  return dataService.tx(async (q) => {
    // FOR UPDATE inside the transaction: two concurrent reserves that both read the
    // same balance would each think there was room for the last credit.
    const account = await q<{ account_id: string; balance: string; reserved: string }>(
      `SELECT account_id, balance::text, reserved::text FROM data_credits.credit_account
        WHERE tenant_id = $1 AND is_active FOR UPDATE`,
      [input.tenant_id],
    );
    if (account.rows.length === 0) throw new NoCreditAccount();
    const balance = Number(account.rows[0].balance);
    const reserved = Number(account.rows[0].reserved);
    const available = balance - reserved;
    if (available < price) throw new InsufficientCredits(price, available);

    const request = await q<{ request_id: string; status: string }>(
      `INSERT INTO data_credits.capability_request
          (tenant_id, capability_id, requested_by_persona_id, role_ref, subject_fingerprint,
           status, metadata)
       VALUES ($1, $2, $3, $4, $5, $6::data_credits.request_status, $7)
       RETURNING request_id, status`,
      [
        input.tenant_id,
        capability.capability_id,
        input.requested_by_persona_id ?? null,
        input.role_ref ?? null,
        input.subject_fingerprint,
        input.requires_approval ? 'PENDING_APPROVAL' : 'APPROVED',
        JSON.stringify(input.metadata ?? {}),
      ],
    );

    const reservation = await q<{ reservation_id: string }>(
      `INSERT INTO data_credits.reservation (tenant_id, request_id, estimated_credits)
       VALUES ($1, $2, $3) RETURNING reservation_id`,
      [input.tenant_id, request.rows[0].request_id, price],
    );

    const after = await q<{ balance: string; reserved: string }>(
      `UPDATE data_credits.credit_account SET reserved = reserved + $2
        WHERE account_id = $1 RETURNING balance::text, reserved::text`,
      [account.rows[0].account_id, price],
    );

    await writeLedger(q, {
      tenant_id: input.tenant_id,
      entry_type: 'RESERVATION',
      request_id: request.rows[0].request_id,
      reservation_id: reservation.rows[0].reservation_id,
      balance_delta: 0,
      reserved_delta: price,
      balance_after: Number(after.rows[0].balance),
      reserved_after: Number(after.rows[0].reserved),
      reason: `held for ${capability.key}`,
    });

    return {
      request_id: request.rows[0].request_id,
      reservation_id: reservation.rows[0].reservation_id,
      capability: toCapabilityView(capability),
      estimated_credits: price,
      status: request.rows[0].status,
    };
  });
}

/* -------------------------------------------------------------- execute */

/** A probe into the result cache. Wired by cacheService; absent means no cache. */
export type CacheProbe = (input: {
  tenant_id: string;
  capability_id: string;
  subject_fingerprint: string;
}) => Promise<{ hit: boolean; result?: unknown }>;

let cacheProbe: CacheProbe | null = null;

export function setCacheProbe(fn: CacheProbe | null): void {
  cacheProbe = fn;
}

export function hasCacheProbe(): boolean {
  return cacheProbe !== null;
}

/** Usage emission into sdk-meter / sdk-billing showback. Optional, never silent. */
export type UsageEmitter = (usage: {
  tenant_id: string;
  request_id: string;
  capability_key: string;
  outcome: SettlementOutcome;
  credits: number;
}) => Promise<void> | void;

let usageEmitter: UsageEmitter | null = null;

export function setUsageEmitter(fn: UsageEmitter | null): void {
  usageEmitter = fn;
}

export function hasUsageEmitter(): boolean {
  return usageEmitter !== null;
}

/** What a tenant sees. No provider, no cost, no attempt count. */
export interface RequestResult {
  request_id: string;
  capability: CapabilityView;
  outcome: SettlementOutcome;
  result: unknown | null;
  credits_charged: number;
  credits_reserved: number;
  served_from_cache: boolean;
  status: string;
}

export class ApprovalRequired extends Error {
  readonly code = 'APPROVAL_REQUIRED';
  constructor(request_id: string) {
    super(`request ${request_id} needs an approval decision before it can execute`);
    this.name = 'ApprovalRequired';
  }
}

/**
 * Run the request: cache first, then the provider chain, then settle.
 *
 * The cache is checked BEFORE the chain and not after, which is the only ordering
 * that can honour "charges nothing and invokes no provider" — a cache consulted
 * afterwards saves money and still spends the vendor call.
 */
export async function execute(input: {
  tenant_id: string;
  request_id: string;
  subject?: unknown;
}): Promise<RequestResult> {
  const row = await loadRequest(input.tenant_id, input.request_id);
  if (row.status === 'PENDING_APPROVAL') throw new ApprovalRequired(input.request_id);

  const capability = await capabilityById(row.capability_id);
  await dataService.query(
    `UPDATE data_credits.capability_request SET status = 'EXECUTING' WHERE request_id = $1`,
    [input.request_id],
  );

  let outcome: SettlementOutcome;
  let result: unknown | null = null;
  let servedFromCache = false;

  const cached = cacheProbe
    ? await cacheProbe({
        tenant_id: input.tenant_id,
        capability_id: row.capability_id,
        subject_fingerprint: row.subject_fingerprint,
      })
    : { hit: false };

  if (cached.hit) {
    outcome = 'CACHE_HIT';
    result = cached.result ?? null;
    servedFromCache = true;
  } else {
    const execution = await executeThroughChain({
      tenant_id: input.tenant_id,
      request_id: input.request_id,
      capability,
      subject: input.subject,
    });
    // Only these two fields cross back. The attempts stay in this scope and in
    // provider_attempt; nothing downstream is even offered them.
    outcome = execution.outcome;
    result = execution.result;
  }

  const settlement = await settle({
    tenant_id: input.tenant_id,
    request_id: input.request_id,
    outcome,
    result,
    served_from_cache: servedFromCache,
  });

  return settlement;
}

/* --------------------------------------------------------------- settle */

export interface SettleInput {
  tenant_id: string;
  request_id: string;
  outcome: SettlementOutcome;
  result?: unknown | null;
  served_from_cache?: boolean;
}

/**
 * Close the reservation and move the money.
 *
 * IDEMPOTENT on the same settlement: an at-least-once caller that retries after a
 * dropped connection gets the same answer and the tenant is charged once. A retry
 * asserting a DIFFERENT outcome is refused rather than merged, because merging
 * means the last retry to arrive decides what was paid.
 */
export async function settle(input: SettleInput): Promise<RequestResult> {
  const chargeable = input.outcome === 'MATCHED';

  return dataService.tx(async (q) => {
    const res = await q<{
      reservation_id: string; estimated_credits: string;
      settled_credits: string | null; outcome: SettlementOutcome | null;
    }>(
      `SELECT r.reservation_id, r.estimated_credits::text,
              r.settled_credits::text, r.outcome
         FROM data_credits.reservation r
        WHERE r.tenant_id = $1 AND r.request_id = $2 FOR UPDATE`,
      [input.tenant_id, input.request_id],
    );
    if (res.rows.length === 0) throw new UnknownRequest(input.request_id);
    const reservation = res.rows[0];
    const quote = Number(reservation.estimated_credits);
    const charge = chargeable ? quote : 0;

    const request = await q<{
      capability_id: string; status: string; served_from_cache: boolean; result: unknown;
    }>(
      `SELECT capability_id, status, served_from_cache, result
         FROM data_credits.capability_request WHERE request_id = $1`,
      [input.request_id],
    );
    const capability = await capabilityById(request.rows[0].capability_id, q);

    if (reservation.outcome !== null) {
      // Already settled. Same settlement -> return it; different -> refuse.
      if (reservation.outcome !== input.outcome || Number(reservation.settled_credits) !== charge) {
        throw new SettlementConflict(
          `request ${input.request_id} already settled as ${reservation.outcome} for ` +
            `${reservation.settled_credits} credits; refusing to re-settle it as ` +
            `${input.outcome} for ${charge}`,
        );
      }
      return {
        request_id: input.request_id,
        capability: toCapabilityView(capability),
        outcome: reservation.outcome,
        result: request.rows[0].result ?? null,
        credits_charged: Number(reservation.settled_credits),
        credits_reserved: quote,
        served_from_cache: request.rows[0].served_from_cache,
        status: request.rows[0].status,
      };
    }

    await q(
      `UPDATE data_credits.reservation
          SET outcome = $2::data_credits.settlement_outcome,
              settled_credits = $3, settled_at = now()
        WHERE reservation_id = $1`,
      [reservation.reservation_id, input.outcome, charge],
    );

    const account = await q<{ account_id: string; balance: string; reserved: string }>(
      `UPDATE data_credits.credit_account
          SET balance = balance - $2, reserved = reserved - $3
        WHERE tenant_id = $1
        RETURNING account_id, balance::text, reserved::text`,
      [input.tenant_id, charge, quote],
    );
    if (account.rows.length === 0) throw new NoCreditAccount();
    const balance_after = Number(account.rows[0].balance);
    const reserved_after = Number(account.rows[0].reserved);

    if (charge > 0) {
      await writeLedger(q, {
        tenant_id: input.tenant_id,
        entry_type: 'CHARGE',
        request_id: input.request_id,
        reservation_id: reservation.reservation_id,
        balance_delta: -charge,
        reserved_delta: -quote,
        balance_after,
        reserved_after,
        reason: `${capability.key} matched`,
      });
    } else if (quote > 0) {
      // The hold comes back and the entry says WHY nothing was charged, so an
      // export can tell a no-match from a failure from a cache hit.
      await writeLedger(q, {
        tenant_id: input.tenant_id,
        entry_type: 'RELEASE',
        request_id: input.request_id,
        reservation_id: reservation.reservation_id,
        balance_delta: 0,
        reserved_delta: -quote,
        balance_after,
        reserved_after,
        reason: `${capability.key} settled ${input.outcome} — nothing charged`,
      });
    }

    const status = input.outcome === 'TECHNICAL_FAILURE' ? 'FAILED' : 'COMPLETED';
    const updated = await q<{ status: string; served_from_cache: boolean; result: unknown }>(
      `UPDATE data_credits.capability_request
          SET status = $2::data_credits.request_status,
              outcome = $3::data_credits.settlement_outcome,
              result = $4::jsonb,
              served_from_cache = $5,
              executed_at = now()
        WHERE request_id = $1
        RETURNING status, served_from_cache, result`,
      [
        input.request_id,
        status,
        input.outcome,
        input.result === undefined || input.result === null ? null : JSON.stringify(input.result),
        input.served_from_cache ?? false,
      ],
    );

    if (usageEmitter) {
      // Failure to meter must not roll back a settlement that already happened —
      // the tenant's balance is the record, metering is a report about it.
      try {
        await usageEmitter({
          tenant_id: input.tenant_id,
          request_id: input.request_id,
          capability_key: capability.key,
          outcome: input.outcome,
          credits: charge,
        });
      } catch {
        /* reported by the emitter's own instrumentation */
      }
    }

    return {
      request_id: input.request_id,
      capability: toCapabilityView(capability),
      outcome: input.outcome,
      result: updated.rows[0].result ?? null,
      credits_charged: charge,
      credits_reserved: quote,
      served_from_cache: updated.rows[0].served_from_cache,
      status: updated.rows[0].status,
    };
  });
}

/* ---------------------------------------------------------------- reads */

export interface BalanceView {
  balance: number;
  reserved: number;
  available: number;
}

export async function getBalance(tenant_id: string): Promise<BalanceView> {
  const account = await loadAccount(tenant_id);
  if (!account) throw new NoCreditAccount();
  const balance = Number(account.balance);
  const reserved = Number(account.reserved);
  return { balance, reserved, available: balance - reserved };
}

export interface LedgerEntryView {
  entry_no: number;
  entry_type: string;
  request_id: string | null;
  balance_delta: number;
  reserved_delta: number;
  balance_after: number;
  reserved_after: number;
  reason: string | null;
  created_at: string;
}

/** The exportable ledger: reservation, charge and refund per request. */
export async function listLedger(filter: {
  tenant_id: string;
  request_id?: string;
  limit?: number;
}): Promise<LedgerEntryView[]> {
  const limit = Math.min(Math.max(filter.limit ?? 100, 1), 1000);
  const rows = await dataService.rows<{
    entry_no: string; entry_type: string; request_id: string | null;
    balance_delta: string; reserved_delta: string; balance_after: string;
    reserved_after: string; reason: string | null; created_at: Date;
  }>(
    `SELECT entry_no::text, entry_type, request_id, balance_delta::text, reserved_delta::text,
            balance_after::text, reserved_after::text, reason, created_at
       FROM data_credits.credit_ledger
      WHERE tenant_id = $1 AND ($2::uuid IS NULL OR request_id = $2)
      ORDER BY entry_no ASC
      LIMIT ${limit}`,
    [filter.tenant_id, filter.request_id ?? null],
  );
  return rows.map((r) => ({
    entry_no: Number(r.entry_no),
    entry_type: r.entry_type,
    request_id: r.request_id,
    balance_delta: Number(r.balance_delta),
    reserved_delta: Number(r.reserved_delta),
    balance_after: Number(r.balance_after),
    reserved_after: Number(r.reserved_after),
    reason: r.reason,
    created_at: new Date(r.created_at).toISOString(),
  }));
}

export async function getRequest(tenant_id: string, request_id: string): Promise<RequestResult> {
  const row = await loadRequest(tenant_id, request_id);
  const capability = await capabilityById(row.capability_id);
  const reservation = await dataService.one<{ estimated_credits: string; settled_credits: string | null }>(
    `SELECT estimated_credits::text, settled_credits::text FROM data_credits.reservation
      WHERE request_id = $1`,
    [request_id],
  );
  return {
    request_id,
    capability: toCapabilityView(capability),
    outcome: row.outcome as SettlementOutcome,
    result: row.result ?? null,
    credits_charged: Number(reservation?.settled_credits ?? 0),
    credits_reserved: Number(reservation?.estimated_credits ?? 0),
    served_from_cache: row.served_from_cache,
    status: row.status,
  };
}

/* -------------------------------------------------------------- helpers */

interface RequestRow {
  request_id: string;
  capability_id: string;
  subject_fingerprint: string;
  status: string;
  outcome: string | null;
  result: unknown;
  served_from_cache: boolean;
}

async function loadRequest(tenant_id: string, request_id: string): Promise<RequestRow> {
  const row = await dataService.one<RequestRow>(
    `SELECT request_id, capability_id, subject_fingerprint, status, outcome, result, served_from_cache
       FROM data_credits.capability_request
      WHERE tenant_id = $1 AND request_id = $2`,
    [tenant_id, request_id],
  );
  if (!row) throw new UnknownRequest(request_id);
  return row;
}

type Q = <R extends Record<string, unknown>>(
  sql: string, params?: unknown[],
) => Promise<{ rows: R[] }>;

async function capabilityById(capability_id: string, q?: Q): Promise<CapabilityRow> {
  const sql = `SELECT capability_id, tenant_id, key, outcome_label, description,
                      credit_price::text AS credit_price, category, is_active
                 FROM data_credits.capability WHERE capability_id = $1`;
  if (q) {
    const res = await q<CapabilityRow & Record<string, unknown>>(sql, [capability_id]);
    return res.rows[0];
  }
  return (await dataService.one<CapabilityRow>(sql, [capability_id])) as CapabilityRow;
}

async function writeLedger(
  q: Q,
  entry: {
    tenant_id: string;
    entry_type: 'GRANT' | 'RESERVATION' | 'CHARGE' | 'REFUND' | 'RELEASE' | 'ADJUSTMENT';
    request_id: string | null;
    reservation_id: string | null;
    balance_delta: number;
    reserved_delta: number;
    balance_after: number;
    reserved_after: number;
    reason: string;
  },
): Promise<void> {
  if (entry.balance_delta === 0 && entry.reserved_delta === 0) return;
  await q(
    `INSERT INTO data_credits.credit_ledger
        (tenant_id, entry_type, request_id, reservation_id, balance_delta, reserved_delta,
         balance_after, reserved_after, reason)
     VALUES ($1, $2::data_credits.ledger_entry_type, $3, $4, $5, $6, $7, $8, $9)`,
    [
      entry.tenant_id, entry.entry_type, entry.request_id, entry.reservation_id,
      entry.balance_delta, entry.reserved_delta, entry.balance_after, entry.reserved_after,
      entry.reason,
    ],
  );
}

/** Add credits to a tenant's account. The GRANT side of the ledger. */
export async function grantCredits(input: {
  tenant_id: string;
  credits: number;
  reason?: string;
}): Promise<BalanceView> {
  return dataService.tx(async (q) => {
    const account = await q<{ account_id: string; balance: string; reserved: string }>(
      `INSERT INTO data_credits.credit_account (tenant_id, balance)
       VALUES ($1, $2)
       ON CONFLICT (tenant_id) DO UPDATE SET balance = data_credits.credit_account.balance + $2
       RETURNING account_id, balance::text, reserved::text`,
      [input.tenant_id, input.credits],
    );
    const balance = Number(account.rows[0].balance);
    const reserved = Number(account.rows[0].reserved);
    await writeLedger(q, {
      tenant_id: input.tenant_id,
      entry_type: 'GRANT',
      request_id: null,
      reservation_id: null,
      balance_delta: input.credits,
      reserved_delta: 0,
      balance_after: balance,
      reserved_after: reserved,
      reason: input.reason ?? 'credit grant',
    });
    return { balance, reserved, available: balance - reserved };
  });
}
