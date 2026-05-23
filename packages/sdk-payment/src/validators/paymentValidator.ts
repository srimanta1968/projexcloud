import type {
  AttachPaymentMethodInput,
  ChargeInput,
  DistributeInput,
  PaymentMethodKind,
  PaymentProvider,
  RefundInput,
} from '../models/payment.model';

export type ValidationResult<T> = { ok: true; value: T } | { ok: false; errors: string[] };

const VALID_PROVIDERS: PaymentProvider[] = ['stripe', 'razorpay', 'plaid', 'ach'];
const VALID_KINDS: PaymentMethodKind[] = ['card', 'bank-account', 'upi', 'wallet'];

function asString(v: unknown): string { return typeof v === 'string' ? v.trim() : ''; }

export function validateAttachMethod(body: unknown): ValidationResult<AttachPaymentMethodInput> {
  if (!body || typeof body !== 'object') return { ok: false, errors: ['body must be an object'] };
  const b = body as Record<string, unknown>;
  const errors: string[] = [];

  const tenant_id = asString(b.tenant_id);
  const persona_id = asString(b.persona_id);
  const provider = asString(b.provider) as PaymentProvider;
  const provider_token = asString(b.provider_token);
  const kind = asString(b.kind) as PaymentMethodKind;

  if (!tenant_id) errors.push('tenant_id is required');
  if (!persona_id) errors.push('persona_id is required');
  if (!VALID_PROVIDERS.includes(provider)) errors.push(`provider must be one of ${VALID_PROVIDERS.join(', ')}`);
  if (!provider_token) errors.push('provider_token is required');
  if (!VALID_KINDS.includes(kind)) errors.push(`kind must be one of ${VALID_KINDS.join(', ')}`);
  if (/\b\d{13,19}\b/.test(provider_token)) {
    errors.push('provider_token looks like a raw card number; refusing per FR-PAY-2 (use the provider token only)');
  }

  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    value: {
      tenant_id, persona_id, provider, provider_token, kind,
      last4: typeof b.last4 === 'string' ? b.last4 : undefined,
      brand: typeof b.brand === 'string' ? b.brand : undefined,
      exp_month: typeof b.exp_month === 'number' ? b.exp_month : undefined,
      exp_year: typeof b.exp_year === 'number' ? b.exp_year : undefined,
      secure_data_field_ref: typeof b.secure_data_field_ref === 'string' ? b.secure_data_field_ref : undefined,
    },
  };
}

export function validateCharge(body: unknown): ValidationResult<ChargeInput> {
  if (!body || typeof body !== 'object') return { ok: false, errors: ['body must be an object'] };
  const b = body as Record<string, unknown>;
  const errors: string[] = [];

  const tenant_id = asString(b.tenant_id);
  const method_id = asString(b.method_id);
  const amount = typeof b.amount === 'number' ? b.amount : Number.NaN;
  const currency = asString(b.currency);
  const encounter_id = typeof b.encounter_id === 'string' ? b.encounter_id : undefined;
  const idempotency_key = typeof b.idempotency_key === 'string' ? b.idempotency_key : undefined;

  if (!tenant_id) errors.push('tenant_id is required');
  if (!method_id) errors.push('method_id is required');
  if (!Number.isFinite(amount) || amount <= 0) errors.push('amount must be a positive number');
  if (!currency || currency.length !== 3) errors.push('currency must be ISO-4217 3-letter');

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, value: { tenant_id, method_id, amount, currency, encounter_id, idempotency_key } };
}

export function validateRefund(body: unknown): ValidationResult<RefundInput> {
  if (!body || typeof body !== 'object') return { ok: false, errors: ['body must be an object'] };
  const b = body as Record<string, unknown>;
  const errors: string[] = [];

  const amount = typeof b.amount === 'number' ? b.amount : Number.NaN;
  const reason = asString(b.reason);

  if (!Number.isFinite(amount) || amount <= 0) errors.push('amount must be a positive number');
  if (!reason) errors.push('reason is required');

  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    value: {
      amount, reason,
      approval_threshold: typeof b.approval_threshold === 'number' ? b.approval_threshold : undefined,
    },
  };
}

export function validateDistribute(body: unknown): ValidationResult<DistributeInput> {
  if (!body || typeof body !== 'object') return { ok: false, errors: ['body must be an object'] };
  const b = body as Record<string, unknown>;
  const errors: string[] = [];

  const charge_id = asString(b.charge_id);
  const currency = asString(b.currency);
  const splits = Array.isArray(b.splits) ? b.splits : null;

  if (!charge_id) errors.push('charge_id is required');
  if (!currency || currency.length !== 3) errors.push('currency must be ISO-4217 3-letter');
  if (!splits || splits.length === 0) errors.push('splits must be a non-empty array');
  else {
    splits.forEach((s, i) => {
      if (!s || typeof s !== 'object') {
        errors.push(`splits[${i}] must be an object`);
        return;
      }
      const ss = s as Record<string, unknown>;
      if (typeof ss.party_persona_id !== 'string') errors.push(`splits[${i}].party_persona_id is required`);
      if (typeof ss.share !== 'number' || ss.share <= 0) errors.push(`splits[${i}].share must be a positive number`);
    });
  }

  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    value: {
      charge_id, currency,
      splits: (splits as Array<{ party_persona_id: string; share: number }>),
    },
  };
}
