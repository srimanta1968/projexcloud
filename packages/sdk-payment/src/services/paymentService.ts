import crypto from 'crypto';
import { dataService } from '@projexlight/db-runtime';
import { emitEvent } from '@projexlight/sdk-audit';
import { getAdapter, toMinorUnits } from './providerAbstraction';
import type {
  AttachPaymentMethodInput,
  ChargeInput,
  ChargeRecord,
  DistributeInput,
  DistributionRecord,
  PaymentMethodRecord,
  RefundInput,
  RefundRecord,
} from '../models/payment.model';

/**
 * sdk-payment service layer per P4 §5.3 / FR-PAY-1..5.
 *
 * All writes route through @projexlight/db-runtime (OC-3). PCI: we never log
 * provider_token in plaintext (audit emits only token_last8); raw PAN never
 * enters this process.
 */

const POOL_INDEX = process.env.POOL_INDEX || 'admin';
const DEFAULT_REFUND_APPROVAL_THRESHOLD = parseFloat(process.env.REFUND_APPROVAL_THRESHOLD ?? '10000');

export class PaymentMethodNotFoundError extends Error {
  readonly code = 'PaymentMethodNotFound';
  constructor(method_id: string) { super(`Payment method ${method_id} not found`); }
}

export class ChargeNotFoundError extends Error {
  readonly code = 'ChargeNotFound';
  constructor(charge_id: string) { super(`Charge ${charge_id} not found`); }
}

export class InsufficientRefundableAmountError extends Error {
  readonly code = 'InsufficientRefundableAmount';
  constructor(message: string) { super(message); }
}

export class TenantOwnershipError extends Error {
  readonly code = 'TenantOwnership';
  constructor(message: string) { super(message); }
}

export class DistributionOversubscribedError extends Error {
  readonly code = 'DistributionOversubscribed';
  constructor(message: string) { super(message); }
}

/**
 * Defense-in-depth ownership check. Routes that hit refund / distribute carry
 * `req.auth.tenant_id` from the verified JWT; this guard ensures the charge
 * referenced actually belongs to the caller's tenant. Without this, a logged-in
 * user from tenant A could refund a tenant B charge if they learned its
 * charge_id. RLS provides a second layer once the policies land at boot.
 */
function assertTenantOwnership(resource_tenant_id: string, actor_tenant_id: string | undefined, kind: string): void {
  if (!actor_tenant_id) {
    throw new TenantOwnershipError(`actor_tenant_id required for ${kind}`);
  }
  if (resource_tenant_id !== actor_tenant_id) {
    throw new TenantOwnershipError(`${kind}: caller tenant ${actor_tenant_id} does not own resource tenant ${resource_tenant_id}`);
  }
}

function tokenLast8(token: string): string {
  // FR-PAY-2: never log full provider tokens. Audit gets last-8 for traceability.
  if (token.length <= 8) return token;
  return `…${token.slice(-8)}`;
}

/* ---------------------------------------------------------- payment methods */

export async function attachPaymentMethod(
  input: AttachPaymentMethodInput,
): Promise<PaymentMethodRecord> {
  const rows = await dataService.rows<PaymentMethodRecord>(
    `INSERT INTO payment.payment_method (
       tenant_id, persona_id, provider, provider_token, kind,
       last4, brand, exp_month, exp_year, secure_data_field_ref
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     ON CONFLICT (provider, provider_token) DO UPDATE
       SET status = 'active'
     RETURNING method_id, tenant_id, persona_id, provider, provider_token, kind,
               last4, brand, exp_month, exp_year, secure_data_field_ref, status, created_at`,
    [
      input.tenant_id,
      input.persona_id,
      input.provider,
      input.provider_token,
      input.kind,
      input.last4 ?? null,
      input.brand ?? null,
      input.exp_month ?? null,
      input.exp_year ?? null,
      input.secure_data_field_ref ?? null,
    ],
  );
  return rows[0];
}

async function getPaymentMethod(method_id: string): Promise<PaymentMethodRecord> {
  const row = await dataService.one<PaymentMethodRecord>(
    `SELECT method_id, tenant_id, persona_id, provider, provider_token, kind,
            last4, brand, exp_month, exp_year, secure_data_field_ref, status, created_at
       FROM payment.payment_method WHERE method_id = $1`,
    [method_id],
  );
  if (!row) throw new PaymentMethodNotFoundError(method_id);
  return row;
}

async function getCharge(charge_id: string): Promise<ChargeRecord> {
  const row = await dataService.one<ChargeRecord>(
    `SELECT charge_id, tenant_id, method_id, encounter_id, amount, currency,
            provider_charge_id, status, occurred_at, captured_at, idempotency_key, failure_reason
       FROM payment.charge WHERE charge_id = $1`,
    [charge_id],
  );
  if (!row) throw new ChargeNotFoundError(charge_id);
  return row;
}

/* ------------------------------------------------------------------ charges */

export async function charge(input: ChargeInput): Promise<ChargeRecord> {
  const method = await getPaymentMethod(input.method_id);
  if (method.status !== 'active') {
    throw new Error(`Payment method ${method.method_id} is ${method.status}`);
  }
  // Cross-tenant guard: caller's tenant must own the payment method being charged.
  if (method.tenant_id !== input.tenant_id) {
    throw new TenantOwnershipError(`charge: payment method ${method.method_id} belongs to a different tenant`);
  }

  // Idempotency: if a prior charge with same (tenant_id, idempotency_key) exists, return it.
  if (input.idempotency_key) {
    const existing = await dataService.one<ChargeRecord>(
      `SELECT charge_id, tenant_id, method_id, encounter_id, amount, currency,
              provider_charge_id, status, occurred_at, captured_at, idempotency_key, failure_reason
         FROM payment.charge WHERE tenant_id = $1 AND idempotency_key = $2`,
      [input.tenant_id, input.idempotency_key],
    );
    if (existing) return existing;
  }

  const inserted = await dataService.rows<ChargeRecord>(
    `INSERT INTO payment.charge (
       tenant_id, method_id, encounter_id, amount, currency, idempotency_key, status
     ) VALUES ($1, $2, $3, $4, $5, $6, 'requires_action')
     RETURNING charge_id, tenant_id, method_id, encounter_id, amount, currency,
               provider_charge_id, status, occurred_at, captured_at, idempotency_key, failure_reason`,
    [
      input.tenant_id,
      input.method_id,
      input.encounter_id ?? null,
      input.amount,
      input.currency.toUpperCase(),
      input.idempotency_key ?? null,
    ],
  );
  let chargeRow = inserted[0];

  // Hand to provider.
  const adapter = getAdapter(method.provider);
  const providerResult = await adapter.charge({
    provider_token: method.provider_token,
    amount_minor: toMinorUnits(input.amount, input.currency),
    currency: input.currency,
    idempotency_key: input.idempotency_key,
  });

  const finalRows = await dataService.rows<ChargeRecord>(
    `UPDATE payment.charge
        SET status = $2, provider_charge_id = $3,
            captured_at = CASE WHEN $2 = 'captured' THEN now() ELSE captured_at END,
            failure_reason = $4
      WHERE charge_id = $1
      RETURNING charge_id, tenant_id, method_id, encounter_id, amount, currency,
                provider_charge_id, status, occurred_at, captured_at, idempotency_key, failure_reason`,
    [
      chargeRow.charge_id,
      providerResult.status,
      providerResult.provider_charge_id,
      providerResult.failure_reason ?? null,
    ],
  );
  chargeRow = finalRows[0];

  await emitEvent({
    event_type: 'payment.charge.v1',
    payload: {
      charge_id: chargeRow.charge_id,
      method_provider: method.provider,
      method_token_last8: tokenLast8(method.provider_token), // FR-PAY-2: never full PAN/token
      amount: chargeRow.amount,
      currency: chargeRow.currency,
      status: chargeRow.status,
      encounter_id: chargeRow.encounter_id,
    },
    pool_index: POOL_INDEX,
    actor_kind: 'service',
    actor_id: 'sdk-payment.charge',
    tenant_id: chargeRow.tenant_id,
    subject_kind: 'payment.charge',
    subject_id: chargeRow.charge_id,
  });

  return chargeRow;
}

/* ----------------------------------------------------------------- refunds */

export async function refund(
  charge_id: string,
  input: RefundInput,
  actor_tenant_id?: string,
): Promise<RefundRecord> {
  const chargeRow = await getCharge(charge_id);
  // FR-PAY-3 hardening: caller must own this charge's tenant.
  assertTenantOwnership(chargeRow.tenant_id, actor_tenant_id, 'refund');
  if (chargeRow.status !== 'captured') {
    throw new Error(`Charge ${charge_id} cannot be refunded from status=${chargeRow.status}`);
  }

  // Sum previously-succeeded refunds against the charge.
  const prior = await dataService.one<{ refunded_total: string }>(
    `SELECT COALESCE(SUM(amount), 0) AS refunded_total
       FROM payment.refund WHERE charge_id = $1 AND status = 'succeeded'`,
    [charge_id],
  );
  const remaining = Number(chargeRow.amount) - Number(prior?.refunded_total ?? 0);
  if (input.amount > remaining) {
    throw new InsufficientRefundableAmountError(
      `Refund amount ${input.amount} exceeds remaining refundable ${remaining}`,
    );
  }

  const approval_threshold = input.approval_threshold ?? DEFAULT_REFUND_APPROVAL_THRESHOLD;
  const needsApproval = input.amount >= approval_threshold;

  // Persist refund request. High-value refunds park at awaiting_approval; the
  // approval_ref FK is filled when sdk-approval issues a route (P4 wiring).
  const rows = await dataService.rows<RefundRecord>(
    `INSERT INTO payment.refund (charge_id, amount, reason, status)
     VALUES ($1, $2, $3, $4)
     RETURNING refund_id, charge_id, amount, reason, status,
               approval_ref, audit_entry_id, provider_refund_id, created_at, resolved_at`,
    [charge_id, input.amount, input.reason, needsApproval ? 'awaiting_approval' : 'pending'],
  );
  let refundRow = rows[0];

  if (needsApproval) {
    // Caller (or workflow worker) later calls completeRefund() after approval.
    return refundRow;
  }

  refundRow = await executeProviderRefund(refundRow, chargeRow);
  return refundRow;
}

/**
 * Drives the provider-side refund after approval clears (or immediately when
 * the amount is below threshold). Updates charge.status to 'refunded' on
 * full refund.
 */
async function executeProviderRefund(
  refundRow: RefundRecord,
  chargeRow: ChargeRecord,
): Promise<RefundRecord> {
  if (!chargeRow.provider_charge_id) {
    throw new Error(`Charge ${chargeRow.charge_id} missing provider_charge_id`);
  }
  const method = await getPaymentMethod(chargeRow.method_id);
  const adapter = getAdapter(method.provider);
  const providerResult = await adapter.refund({
    provider_charge_id: chargeRow.provider_charge_id,
    amount_minor: toMinorUnits(Number(refundRow.amount), chargeRow.currency),
    reason: refundRow.reason,
  });

  const finalRows = await dataService.rows<RefundRecord>(
    `UPDATE payment.refund
        SET status = $2, provider_refund_id = $3, resolved_at = now()
      WHERE refund_id = $1
      RETURNING refund_id, charge_id, amount, reason, status,
                approval_ref, audit_entry_id, provider_refund_id, created_at, resolved_at`,
    [refundRow.refund_id, providerResult.status, providerResult.provider_refund_id],
  );
  const final = finalRows[0];

  if (providerResult.status === 'succeeded') {
    // Flip charge.status to 'refunded' when fully refunded.
    const remaining = await dataService.one<{ refunded_total: string }>(
      `SELECT COALESCE(SUM(amount), 0) AS refunded_total
         FROM payment.refund WHERE charge_id = $1 AND status = 'succeeded'`,
      [chargeRow.charge_id],
    );
    if (Number(remaining?.refunded_total ?? 0) >= Number(chargeRow.amount)) {
      await dataService.query(
        `UPDATE payment.charge SET status = 'refunded' WHERE charge_id = $1`,
        [chargeRow.charge_id],
      );
    }
  }

  await emitEvent({
    event_type: 'payment.refund.v1',
    payload: {
      refund_id: final.refund_id,
      charge_id: final.charge_id,
      amount: final.amount,
      reason: final.reason,
      status: final.status,
    },
    pool_index: POOL_INDEX,
    actor_kind: 'service',
    actor_id: 'sdk-payment.refund',
    tenant_id: chargeRow.tenant_id,
    subject_kind: 'payment.refund',
    subject_id: final.refund_id,
  });

  return final;
}

/**
 * Called by an approval workflow callback (sdk-approval P4) once the refund
 * has cleared the required chain. Sets approval_ref + executes the provider
 * refund.
 */
export async function completeRefundAfterApproval(
  refund_id: string,
  approval_ref: string,
): Promise<RefundRecord> {
  const row = await dataService.one<RefundRecord>(
    `SELECT refund_id, charge_id, amount, reason, status,
            approval_ref, audit_entry_id, provider_refund_id, created_at, resolved_at
       FROM payment.refund WHERE refund_id = $1`,
    [refund_id],
  );
  if (!row) throw new Error(`Refund ${refund_id} not found`);
  if (row.status !== 'awaiting_approval' && row.status !== 'approved') {
    throw new Error(`Refund ${refund_id} in status=${row.status}; cannot complete`);
  }

  await dataService.query(
    `UPDATE payment.refund SET approval_ref = $2, status = 'approved' WHERE refund_id = $1`,
    [refund_id, approval_ref],
  );

  const chargeRow = await getCharge(row.charge_id);
  return executeProviderRefund({ ...row, approval_ref, status: 'approved' }, chargeRow);
}

/* ------------------------------------------------ distribution ledger (FR-PAY-4) */

function hashDistribution(parts: {
  prev_hash: Buffer | null;
  charge_id: string;
  party_persona_id: string;
  share: string;
  currency: string;
  occurred_at: Date;
}): Buffer {
  const canonical = JSON.stringify({
    prev_hash: parts.prev_hash ? parts.prev_hash.toString('hex') : null,
    charge_id: parts.charge_id,
    party_persona_id: parts.party_persona_id,
    share: parts.share,
    currency: parts.currency,
    occurred_at: parts.occurred_at.toISOString(),
  });
  return crypto.createHash('sha256').update(canonical).digest();
}

export async function distribute(
  input: DistributeInput,
  actor_tenant_id?: string,
): Promise<DistributionRecord[]> {
  const chargeRow = await getCharge(input.charge_id);
  assertTenantOwnership(chargeRow.tenant_id, actor_tenant_id, 'distribute');
  if (chargeRow.status !== 'captured') {
    throw new Error(`Cannot distribute charge in status=${chargeRow.status}`);
  }

  // Sanity: this batch's splits must not exceed charge amount.
  const batchShare = input.splits.reduce((acc, s) => acc + s.share, 0);
  if (batchShare > Number(chargeRow.amount)) {
    throw new Error(`Splits sum ${batchShare} exceeds charge amount ${chargeRow.amount}`);
  }
  // FR-PAY-4 hardening: cumulative sum of prior distributions PLUS this batch
  // must not exceed the charge amount. The old check only looked at the
  // current call, so two sequential distribute() calls could push past 100%.
  const prior = await dataService.one<{ distributed_total: string }>(
    `SELECT COALESCE(SUM(share::numeric), 0) AS distributed_total
       FROM payment.distribution WHERE charge_id = $1`,
    [input.charge_id],
  );
  const cumulative = Number(prior?.distributed_total ?? 0) + batchShare;
  if (cumulative > Number(chargeRow.amount)) {
    throw new DistributionOversubscribedError(
      `cumulative distribution ${cumulative} would exceed charge amount ${chargeRow.amount} (prior=${prior?.distributed_total ?? 0}, batch=${batchShare})`,
    );
  }

  const out: DistributionRecord[] = [];
  for (const split of input.splits) {
    // Hash-chain head — last entry's entry_hash for this charge.
    const head = await dataService.one<{ entry_hash: Buffer }>(
      `SELECT entry_hash FROM payment.distribution
        WHERE charge_id = $1 ORDER BY seq DESC LIMIT 1`,
      [input.charge_id],
    );
    const occurred_at = new Date();
    const shareStr = split.share.toString();
    const entry_hash = hashDistribution({
      prev_hash: head?.entry_hash ?? null,
      charge_id: input.charge_id,
      party_persona_id: split.party_persona_id,
      share: shareStr,
      currency: input.currency.toUpperCase(),
      occurred_at,
    });

    const rows = await dataService.rows<DistributionRecord>(
      `INSERT INTO payment.distribution
         (charge_id, party_persona_id, share, currency, occurred_at, prev_hash, entry_hash)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING distribution_id, charge_id, party_persona_id, share, currency,
                 occurred_at, prev_hash, entry_hash, seq`,
      [
        input.charge_id,
        split.party_persona_id,
        shareStr,
        input.currency.toUpperCase(),
        occurred_at,
        head?.entry_hash ?? null,
        entry_hash,
      ],
    );
    out.push(rows[0]);

    await emitEvent({
      event_type: 'payment.distributed.v1',
      payload: {
        distribution_id: rows[0].distribution_id,
        charge_id: input.charge_id,
        party_persona_id: split.party_persona_id,
        share: shareStr,
        currency: input.currency,
      },
      pool_index: POOL_INDEX,
      actor_kind: 'service',
      actor_id: 'sdk-payment.distribute',
      tenant_id: chargeRow.tenant_id,
      subject_kind: 'payment.distribution',
      subject_id: rows[0].distribution_id,
    });
  }
  return out;
}

/**
 * Verifies the distribution hash chain for a charge. Used by reconciliation
 * jobs to prove the immutable ledger hasn't been tampered with.
 */
export async function verifyDistributionChain(charge_id: string): Promise<{
  ok: boolean;
  break_at_seq?: string;
  reason?: string;
}> {
  const rows = await dataService.rows<DistributionRecord>(
    `SELECT distribution_id, charge_id, party_persona_id, share, currency,
            occurred_at, prev_hash, entry_hash, seq
       FROM payment.distribution
      WHERE charge_id = $1
      ORDER BY seq ASC`,
    [charge_id],
  );
  let prev: Buffer | null = null;
  for (const r of rows) {
    if ((prev === null) !== (r.prev_hash === null)) {
      return { ok: false, break_at_seq: r.seq, reason: 'prev_hash chain misaligned' };
    }
    if (prev && r.prev_hash && !prev.equals(r.prev_hash)) {
      return { ok: false, break_at_seq: r.seq, reason: 'prev_hash mismatch' };
    }
    const recomputed = hashDistribution({
      prev_hash: r.prev_hash,
      charge_id: r.charge_id,
      party_persona_id: r.party_persona_id,
      share: r.share,
      currency: r.currency,
      occurred_at: r.occurred_at,
    });
    if (!recomputed.equals(r.entry_hash)) {
      return { ok: false, break_at_seq: r.seq, reason: 'entry_hash mismatch (tampered row)' };
    }
    prev = r.entry_hash;
  }
  return { ok: true };
}
