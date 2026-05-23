import type Stripe from 'stripe';
import { dataService } from '@projexlight/db-runtime';
import { appendAuditEntry } from '@projexlight/sdk-audit';
import { getStripeClient } from '../../services/stripeAdapter';

/**
 * Stripe webhook receiver per FR-PAY-1 and FR-BIL-2.
 *
 * Three event families we ingest today:
 *   - payment_intent.succeeded  → reconcile payment.charge to 'captured'
 *   - charge.refunded           → reconcile payment.refund to 'succeeded'
 *   - invoice.payment_succeeded → forward to sdk-billing via late-bound
 *                                  hook so this package stays free of a
 *                                  sdk-billing dep
 *
 * Authentication is signature-based — the Stripe-Signature header is
 * verified with STRIPE_WEBHOOK_SECRET. There is intentionally NO bearer
 * auth on the route; Stripe is the authenticator.
 *
 * Idempotency: each branch is a write that uses provider_charge_id /
 * provider_refund_id / stripe_invoice_id as the join key, so replays land
 * on the same row. Stripe replays the same event_id on 5xx and times out
 * at 2xx, so we return 200 even for unknown event types.
 */

/* -------------------------------------------------------------------- types */

export interface StripeWebhookVerifyError extends Error {
  readonly code: 'SignatureVerificationFailed';
}

/* ----------------------------------------------------- late-bound hook for sdk-billing */

/**
 * sdk-billing registers its handler via setInvoicePaidHandler at boot. Until
 * then, we still record the audit envelope but skip the billing.invoice row
 * update (the next dunning sweep will catch it).
 */
type InvoicePaidHandler = (stripe_invoice_id: string) => Promise<void>;
let _invoicePaidHandler: InvoicePaidHandler | null = null;

export function setInvoicePaidHandler(fn: InvoicePaidHandler | null): void {
  _invoicePaidHandler = fn;
}

/* --------------------------------------------------- signature verification */

/**
 * Verifies the raw request body against the Stripe-Signature header.
 *
 * IMPORTANT: rawBody MUST be the exact bytes received — JSON.parse +
 * JSON.stringify rewrites whitespace/key-order and the HMAC will fail.
 * The route handler reads the buffer via a fastify content-type parser.
 *
 * Throws on missing env, missing signature, or HMAC mismatch — the route
 * catches and maps to 400.
 */
export function verifyStripeWebhook(
  rawBody: Buffer | string,
  signatureHeader: string | undefined,
): Stripe.Event {
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secret) throw new Error('STRIPE_WEBHOOK_SECRET missing');
  if (!signatureHeader) throw new Error('stripe-signature header missing');
  // constructEvent throws Stripe.errors.StripeSignatureVerificationError on
  // bad sig; we propagate so the route can return 400 (Stripe will retry).
  return getStripeClient().webhooks.constructEvent(rawBody, signatureHeader, secret);
}

/* --------------------------------------------------------- event dispatcher */

export async function handleStripeWebhook(event: Stripe.Event): Promise<void> {
  // Wrap in try/catch so a failure on any branch surfaces a 500 to Stripe
  // (which triggers exponential-backoff retry over the next 3 days).
  try {
    switch (event.type) {
      case 'payment_intent.succeeded': {
        const pi = event.data.object as Stripe.PaymentIntent;
        // Idempotent UPDATE keyed on the Stripe pi id, which we wrote as
        // provider_charge_id at charge time. Captures any race where
        // confirm=true was 'requires_action' before clearing async.
        await dataService.query(
          `UPDATE payment.charge
              SET status = 'captured',
                  captured_at = COALESCE(captured_at, now())
            WHERE provider_charge_id = $1
              AND status <> 'captured'`,
          [pi.id],
        );
        return;
      }

      case 'charge.refunded': {
        // The 'charge.refunded' event payload is a Stripe Charge with a
        // refunds[] array. We mark each known refund id as succeeded.
        const charge = event.data.object as Stripe.Charge;
        const refundIds = (charge.refunds?.data ?? []).map((r) => r.id);
        if (refundIds.length === 0) return;
        await dataService.query(
          `UPDATE payment.refund
              SET status = 'succeeded',
                  resolved_at = COALESCE(resolved_at, now())
            WHERE provider_refund_id = ANY($1::text[])
              AND status <> 'succeeded'`,
          [refundIds],
        );
        return;
      }

      case 'invoice.payment_succeeded': {
        const inv = event.data.object as Stripe.Invoice;
        const stripeInvoiceId = inv.id;
        if (!stripeInvoiceId) return;

        // Forward to sdk-billing through the late-bound hook (avoids
        // sdk-payment → sdk-billing dep cycle). The hook updates
        // billing.invoice.status='paid' + paid_at.
        if (_invoicePaidHandler) {
          await _invoicePaidHandler(stripeInvoiceId);
        }

        // Always emit the audit envelope so the chain reflects the event
        // even if the billing hook hasn't been wired yet. Pulls tenant_id
        // off the billing.invoice row when present (best-effort).
        const row = await dataService.one<{ invoice_id: string; tenant_id: string }>(
          `SELECT invoice_id, tenant_id FROM billing.invoice WHERE stripe_invoice_id = $1`,
          [stripeInvoiceId],
        );
        await appendAuditEntry({
          pool_index: 'admin',
          event_type: 'billing.invoice.paid.v1',
          tenant_id: row?.tenant_id ?? null,
          actor_kind: 'service',
          actor_id: 'sdk-payment.stripe-webhook',
          subject_kind: 'invoice',
          subject_id: row?.invoice_id ?? stripeInvoiceId,
          retention_class: 'regulated',
          payload: {
            stripe_invoice_id: stripeInvoiceId,
            invoice_id: row?.invoice_id ?? null,
            amount_paid: inv.amount_paid,
            currency: inv.currency,
            stripe_event_id: event.id,
          },
        });
        return;
      }

      default:
        // Unknown event type — Stripe expects a 2xx so it stops retrying.
        // Log only; the audit chain is intentionally not cluttered with
        // events we don't act on.
        return;
    }
  } catch (err) {
    // Re-throw so the route returns 500 → Stripe retries with backoff.
    throw err;
  }
}
