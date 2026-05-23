/**
 * TypeScript model mirroring payment.* tables per P4-Operational-Billing-DataModel §6.
 */

export type PaymentProvider = 'stripe' | 'razorpay' | 'plaid' | 'ach';
export type PaymentMethodKind = 'card' | 'bank-account' | 'upi' | 'wallet';
export type PaymentMethodStatus = 'active' | 'expired' | 'revoked';
export type ChargeStatus =
  | 'requires_action'
  | 'authorized'
  | 'captured'
  | 'failed'
  | 'refunded'
  | 'disputed';
export type RefundStatus =
  | 'pending'
  | 'awaiting_approval'
  | 'approved'
  | 'rejected'
  | 'succeeded'
  | 'failed';

export interface PaymentMethodRecord {
  method_id: string;
  tenant_id: string;
  persona_id: string;
  provider: PaymentProvider;
  provider_token: string;
  kind: PaymentMethodKind;
  last4: string | null;
  brand: string | null;
  exp_month: number | null;
  exp_year: number | null;
  secure_data_field_ref: string | null;
  status: PaymentMethodStatus;
  created_at: Date;
}

export interface ChargeRecord {
  charge_id: string;
  tenant_id: string;
  method_id: string;
  encounter_id: string | null;
  amount: string; // NUMERIC comes back as string from pg
  currency: string;
  provider_charge_id: string | null;
  status: ChargeStatus;
  occurred_at: Date;
  captured_at: Date | null;
  idempotency_key: string | null;
  failure_reason: string | null;
}

export interface RefundRecord {
  refund_id: string;
  charge_id: string;
  amount: string;
  reason: string;
  status: RefundStatus;
  approval_ref: string | null;
  audit_entry_id: string | null;
  provider_refund_id: string | null;
  created_at: Date;
  resolved_at: Date | null;
}

export interface DistributionRecord {
  distribution_id: string;
  charge_id: string;
  party_persona_id: string;
  share: string;
  currency: string;
  occurred_at: Date;
  prev_hash: Buffer | null;
  entry_hash: Buffer;
  seq: string;
}

/* --------- inputs --------- */

export interface AttachPaymentMethodInput {
  tenant_id: string;
  persona_id: string;
  provider: PaymentProvider;
  provider_token: string;
  kind: PaymentMethodKind;
  last4?: string;
  brand?: string;
  exp_month?: number;
  exp_year?: number;
  secure_data_field_ref?: string;
}

export interface ChargeInput {
  tenant_id: string;
  method_id: string;
  amount: number; // human-friendly, persisted as NUMERIC
  currency: string;
  encounter_id?: string;
  idempotency_key?: string;
}

export interface RefundInput {
  amount: number;
  reason: string;
  /** Threshold above which the refund needs sdk-approval routing. Default $10k. */
  approval_threshold?: number;
}

export interface DistributeInput {
  charge_id: string;
  splits: Array<{ party_persona_id: string; share: number }>;
  currency: string;
}
