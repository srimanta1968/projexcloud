import type { PaymentProvider } from '../models/payment.model';

/**
 * Provider abstraction per FR-PAY-1.
 *
 * Unifies Stripe / Razorpay / Plaid / ACH behind a common surface so the rest
 * of the SDK never branches on provider identity. PCI guarantee per FR-PAY-2:
 * raw PAN never enters this process. Callers supply provider-side tokens
 * (Stripe `pi_*`, Razorpay `token_*`, Plaid `access_*`) which we store in
 * payment_method.provider_token and pass through verbatim.
 *
 * Adapters here are synthetic — they succeed deterministically against the
 * provider_token so we can drive AC-3 (no raw PAN in any log) with full
 * round-trips. Production deploys swap in @stripe/stripe-node etc. at boot
 * via registerAdapter().
 *
 * Failover: Stripe-only failover per PRD NFR (30s window) — we retry the
 * same provider before considering the charge failed; cross-provider failover
 * is out of scope for P4 (charges are tied to a specific method_id).
 */

export interface ProviderChargeArgs {
  provider_token: string;
  amount_minor: number; // amount in smallest currency unit (cents/paisa)
  currency: string;
  idempotency_key?: string;
}

export interface ProviderChargeResult {
  provider_charge_id: string;
  status: 'authorized' | 'captured' | 'failed';
  failure_reason?: string;
}

export interface ProviderRefundArgs {
  provider_charge_id: string;
  amount_minor: number;
  reason: string;
}

export interface ProviderRefundResult {
  provider_refund_id: string;
  status: 'succeeded' | 'failed';
  failure_reason?: string;
}

export interface ProviderAdapter {
  readonly provider: PaymentProvider;
  charge(args: ProviderChargeArgs): Promise<ProviderChargeResult>;
  refund(args: ProviderRefundArgs): Promise<ProviderRefundResult>;
}

/**
 * Synthetic adapters drive tests deterministically. In prod (NODE_ENV=production),
 * we refuse to run them — every charge/refund would silently succeed without
 * ever talking to the real PSP, which is worse than failing fast. Operators
 * MUST call registerAdapter() at boot with a real Stripe/Razorpay/Plaid client,
 * OR set ALLOW_SYNTHETIC_PAYMENT_PROVIDERS=true to override (sandbox tenants).
 */
const SYNTHETIC_ALLOWED = (): boolean => {
  if (process.env.NODE_ENV !== 'production') return true;
  return process.env.ALLOW_SYNTHETIC_PAYMENT_PROVIDERS === 'true';
};

function makeSyntheticAdapter(provider: PaymentProvider): ProviderAdapter {
  return {
    provider,
    async charge(args): Promise<ProviderChargeResult> {
      if (!SYNTHETIC_ALLOWED()) {
        throw new Error(`sdk-payment: provider '${provider}' is the synthetic stub in production — register a real adapter via registerAdapter() before boot, or set ALLOW_SYNTHETIC_PAYMENT_PROVIDERS=true for sandbox tenants`);
      }
      if (args.provider_token.startsWith('decline_')) {
        return {
          provider_charge_id: `${provider}_failed_${Date.now().toString(36)}`,
          status: 'failed',
          failure_reason: 'card_declined',
        };
      }
      return {
        provider_charge_id: `${provider}_ch_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
        status: 'captured',
      };
    },
    async refund(args): Promise<ProviderRefundResult> {
      if (!SYNTHETIC_ALLOWED()) {
        throw new Error(`sdk-payment: provider '${provider}' is the synthetic stub in production — register a real adapter via registerAdapter() before boot, or set ALLOW_SYNTHETIC_PAYMENT_PROVIDERS=true for sandbox tenants`);
      }
      if (args.provider_charge_id.includes('_failed_')) {
        return {
          provider_refund_id: `${provider}_re_failed_${Date.now().toString(36)}`,
          status: 'failed',
          failure_reason: 'cannot refund failed charge',
        };
      }
      return {
        provider_refund_id: `${provider}_re_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
        status: 'succeeded',
      };
    },
  };
}

const REGISTRY: Record<PaymentProvider, ProviderAdapter> = {
  stripe: makeSyntheticAdapter('stripe'),
  razorpay: makeSyntheticAdapter('razorpay'),
  plaid: makeSyntheticAdapter('plaid'),
  ach: makeSyntheticAdapter('ach'),
};

export function getAdapter(provider: PaymentProvider): ProviderAdapter {
  return REGISTRY[provider];
}

/** Swap in real vendor adapters at boot (Stripe, Razorpay, etc.). */
export function registerAdapter(adapter: ProviderAdapter): void {
  REGISTRY[adapter.provider] = adapter;
}

/**
 * Converts human-friendly amount (1.50 USD) → provider minor units (150 cents).
 * Currencies that don't subdivide (JPY) pass through unchanged.
 */
const ZERO_DECIMAL = new Set(['BIF', 'CLP', 'DJF', 'GNF', 'JPY', 'KMF', 'KRW', 'MGA', 'PYG', 'RWF', 'UGX', 'VND', 'VUV', 'XAF', 'XOF', 'XPF']);

export function toMinorUnits(amount: number, currency: string): number {
  if (ZERO_DECIMAL.has(currency.toUpperCase())) return Math.round(amount);
  return Math.round(amount * 100);
}
