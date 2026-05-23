import Stripe from 'stripe';
import {
  registerAdapter,
  type ProviderAdapter,
  type ProviderChargeArgs,
  type ProviderChargeResult,
  type ProviderRefundArgs,
  type ProviderRefundResult,
} from './providerAbstraction';

/**
 * Real Stripe adapter per FR-PAY-1.
 *
 * Replaces the synthetic stub in providerAbstraction.ts whenever
 * STRIPE_API_KEY is present at boot. The synthetic adapter is retained as
 * the fallback for unconfigured tenants but is forbidden in production
 * unless ALLOW_SYNTHETIC_PAYMENT_PROVIDERS=true (sandbox tenants).
 *
 * Token model (FR-PAY-2): callers supply a Stripe payment_method id
 * (pm_*) as provider_token; raw PAN never enters this process. We pass
 * the token verbatim to paymentIntents.create with confirm=true so the
 * full auth+capture round-trips in one call. The returned PaymentIntent
 * id (pi_*) becomes our provider_charge_id and is the join key for
 * subsequent refunds and webhook reconciliation.
 *
 * Idempotency: Stripe's idempotency_key option dedupes server-side for
 * 24h, so retries of the same charge request return the original PI
 * without double-billing.
 */

/** Cached Stripe client. Lazily constructed so test envs can boot without a key. */
let _client: Stripe | null = null;

function getClient(): Stripe {
  if (_client) return _client;
  const key = process.env.STRIPE_API_KEY;
  if (!key) throw new Error('STRIPE_API_KEY missing');
  _client = new Stripe(key, {
    // Pin the API version so server-side schema changes never surprise us.
    // Bump deliberately after smoke testing in staging.
    apiVersion: '2024-06-20' as Stripe.LatestApiVersion,
    typescript: true,
  });
  return _client;
}

/**
 * Maps Stripe PaymentIntent status → ProviderAdapter status enum.
 *
 * 'succeeded'                     → captured (auth+capture both done)
 * 'requires_capture'              → captured (we treat manual-capture as
 *                                    out-of-scope for the synchronous path;
 *                                    if you build auth-only flows, surface
 *                                    'authorized' here and capture later)
 * everything else (canceled,
 * requires_action, requires_*)    → failed
 *
 * We do NOT surface 'authorized' from the default flow because charge()
 * always passes confirm=true.
 */
function mapPaymentIntentStatus(
  status: Stripe.PaymentIntent.Status,
): 'captured' | 'failed' {
  if (status === 'succeeded') return 'captured';
  return 'failed';
}

/**
 * Maps internal refund reason strings to Stripe's enum. Stripe accepts only
 * three values; everything else must be passed as null (Stripe rejects
 * arbitrary strings). The original human reason still lives on
 * payment.refund.reason for the audit trail.
 */
function stripeReason(reason: string): Stripe.RefundCreateParams.Reason | undefined {
  const r = (reason || '').toLowerCase();
  if (r.includes('duplicate')) return 'duplicate';
  if (r.includes('fraud')) return 'fraudulent';
  if (r.includes('request') || r.includes('customer') || r.includes('user')) {
    return 'requested_by_customer';
  }
  return undefined;
}

class StripeAdapter implements ProviderAdapter {
  readonly provider = 'stripe' as const;

  async charge(args: ProviderChargeArgs): Promise<ProviderChargeResult> {
    const stripe = getClient();
    try {
      const pi = await stripe.paymentIntents.create(
        {
          amount: args.amount_minor,
          currency: args.currency.toLowerCase(),
          payment_method: args.provider_token,
          confirm: true,
          // Off-session avoids the SCA challenge for stored methods; if you
          // need 3DS step-up, switch to off_session=false and surface the
          // pi.next_action to the caller via a 'requires_action' status.
          off_session: true,
          // Stripe automatically handles digital wallets / cards / bank
          // debit from the payment_method id — no separate type switch.
          automatic_payment_methods: { enabled: true, allow_redirects: 'never' },
        },
        args.idempotency_key ? { idempotencyKey: args.idempotency_key } : undefined,
      );

      const status = mapPaymentIntentStatus(pi.status);
      const result: ProviderChargeResult = {
        provider_charge_id: pi.id,
        status,
      };
      if (status === 'failed') {
        result.failure_reason = pi.last_payment_error?.message ?? `payment_intent_status:${pi.status}`;
      }
      return result;
    } catch (err) {
      // Stripe SDK throws StripeError subclasses on declines / network
      // failures. We surface the message but keep a synthetic pi id so the
      // payment.charge row insert in paymentService doesn't blow up on a
      // non-null constraint. Reconciliation runs against the audit chain.
      const stripeErr = err as Stripe.errors.StripeError;
      return {
        provider_charge_id: stripeErr.payment_intent?.id ?? `stripe_err_${Date.now().toString(36)}`,
        status: 'failed',
        failure_reason: stripeErr.message ?? 'stripe_charge_failed',
      };
    }
  }

  async refund(args: ProviderRefundArgs): Promise<ProviderRefundResult> {
    const stripe = getClient();
    try {
      const params: Stripe.RefundCreateParams = {
        payment_intent: args.provider_charge_id,
        amount: args.amount_minor,
      };
      const mapped = stripeReason(args.reason);
      if (mapped) params.reason = mapped;

      const re = await stripe.refunds.create(params);
      const status: 'succeeded' | 'failed' = re.status === 'succeeded' ? 'succeeded' : 'failed';
      const result: ProviderRefundResult = {
        provider_refund_id: re.id,
        status,
      };
      if (status === 'failed') {
        result.failure_reason = re.failure_reason ?? `refund_status:${re.status}`;
      }
      return result;
    } catch (err) {
      const stripeErr = err as Stripe.errors.StripeError;
      return {
        provider_refund_id: `stripe_re_err_${Date.now().toString(36)}`,
        status: 'failed',
        failure_reason: stripeErr.message ?? 'stripe_refund_failed',
      };
    }
  }
}

/**
 * Boot-time hook: swaps the synthetic Stripe stub for the real one
 * IFF STRIPE_API_KEY is set. Returns true when the real adapter was
 * registered, false when env is unconfigured (synthetic stays as fallback).
 *
 * Safe to call multiple times — registerAdapter overwrites the registry slot.
 */
export function registerStripeAdapter(): boolean {
  if (!process.env.STRIPE_API_KEY) return false;
  registerAdapter(new StripeAdapter());
  return true;
}

/** Exposed for the webhook handler — same singleton client. */
export function getStripeClient(): Stripe {
  return getClient();
}
