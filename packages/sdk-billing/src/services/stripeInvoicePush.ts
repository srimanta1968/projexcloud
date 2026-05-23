import Stripe from 'stripe';
import { dataService } from '@projexlight/db-runtime';
import type { InvoiceRecord, LineItemRecord } from '../models/billing.model';

/**
 * Stripe invoice push per FR-BIL-2.
 *
 * Pushes a finalized billing.invoice + line_items into Stripe as a real
 * Stripe Invoice so customers can pay through Stripe's hosted page. The
 * resulting Stripe invoice id is persisted back on billing.invoice so the
 * `invoice.payment_succeeded` webhook (handled in sdk-payment) can flip
 * status='paid' via the late-bound hook.
 *
 * Push pipeline:
 *   1. stripe.invoices.create({ customer, currency, collection_method, ... })
 *   2. stripe.invoiceItems.create(...) per line — attached to the same
 *      customer + invoice (so finalize sums them).
 *   3. stripe.invoices.finalizeInvoice(invoice.id) → returns hosted_invoice_url.
 *
 * Idempotency: if billing.invoice.stripe_invoice_id is already set, we
 * skip the push and return the existing id. This protects against double
 * pushes from retried dunning ticks.
 *
 * Customer mapping: we assume a 1-to-1 tenant→Stripe-customer mapping
 * keyed off env `STRIPE_TENANT_CUSTOMER_TABLE` (defaults to
 * billing.stripe_customer_map). When no row exists, we lazily create the
 * customer with the tenant_id as the external metadata key.
 */

/* -------------------------------------------------------------- types */

export interface PushInvoiceResult {
  stripe_invoice_id: string;
  hosted_invoice_url: string | null;
}

/* -------------------------------------------------------------- client */

let _client: Stripe | null = null;

function getClient(): Stripe {
  if (_client) return _client;
  const key = process.env.STRIPE_API_KEY;
  if (!key) throw new Error('STRIPE_API_KEY missing');
  _client = new Stripe(key, {
    apiVersion: '2024-06-20' as Stripe.LatestApiVersion,
    typescript: true,
  });
  return _client;
}

/**
 * Boot-time hook — primes the singleton client and validates the env. Safe
 * to call from api-gateway start(); returns true when ready.
 */
export function registerStripeForInvoicePush(): boolean {
  if (!process.env.STRIPE_API_KEY) return false;
  getClient();
  return true;
}

/* ---------------------------------------------------- customer mapping */

/**
 * Returns the Stripe customer id for a tenant, creating one on first push.
 * Map row lives in billing.stripe_customer_map (tenant_id → stripe_customer_id).
 *
 * We don't migration-create the table here (sdk-billing migrations are
 * owned by the schema spine); the table is expected to exist by P4 spec.
 * If it's missing, we fall back to creating a customer on every push,
 * which still works (Stripe dedupes via the metadata.tenant_id field) but
 * is wasteful — log a warning so ops notices.
 */
async function ensureStripeCustomer(stripe: Stripe, tenant_id: string): Promise<string> {
  try {
    const row = await dataService.one<{ stripe_customer_id: string }>(
      `SELECT stripe_customer_id FROM billing.stripe_customer_map WHERE tenant_id = $1`,
      [tenant_id],
    );
    if (row?.stripe_customer_id) return row.stripe_customer_id;
  } catch {
    // Table absent — fall through to create-and-warn path.
    console.warn('[sdk-billing] billing.stripe_customer_map missing; creating Stripe customer per push');
  }

  const cust = await stripe.customers.create({
    metadata: { tenant_id },
    description: `ProjexCloud tenant ${tenant_id}`,
  });

  // Best-effort persist for next time. Ignore the error if the table is
  // absent — the warning above already fired.
  try {
    await dataService.query(
      `INSERT INTO billing.stripe_customer_map (tenant_id, stripe_customer_id)
         VALUES ($1, $2)
         ON CONFLICT (tenant_id) DO UPDATE
           SET stripe_customer_id = EXCLUDED.stripe_customer_id`,
      [tenant_id, cust.id],
    );
  } catch {
    /* ignore */
  }
  return cust.id;
}

/* ---------------------------------------------------------------- push */

/**
 * Converts a billing.line_item amount (NUMERIC, may have 4 decimals) into
 * Stripe minor units (integer cents/paisa). Zero-decimal currencies (JPY,
 * KRW, etc.) pass through as whole units.
 */
const ZERO_DECIMAL = new Set([
  'BIF','CLP','DJF','GNF','JPY','KMF','KRW','MGA','PYG','RWF','UGX','VND','VUV','XAF','XOF','XPF',
]);

function toMinor(amount: string | number, currency: string): number {
  const n = typeof amount === 'string' ? parseFloat(amount) : amount;
  if (ZERO_DECIMAL.has(currency.toUpperCase())) return Math.round(n);
  return Math.round(n * 100);
}

export async function pushInvoiceToStripe(
  invoice_id: string,
  line_items: LineItemRecord[],
): Promise<PushInvoiceResult> {
  const stripe = getClient();

  // Load the invoice row to get tenant_id + currency + idempotency check.
  const invoice = await dataService.one<InvoiceRecord>(
    `SELECT invoice_id, tenant_id, catalog_id, fiscal_period_id,
            period_start, period_end, subtotal, tax, total, currency,
            status, pdf_s3_key, stripe_invoice_id,
            generated_at, finalized_at, paid_at
       FROM billing.invoice WHERE invoice_id = $1`,
    [invoice_id],
  );
  if (!invoice) throw new Error(`Invoice ${invoice_id} not found`);

  // Idempotent: skip push if already linked.
  if (invoice.stripe_invoice_id) {
    const existing = await stripe.invoices.retrieve(invoice.stripe_invoice_id);
    return {
      stripe_invoice_id: existing.id ?? invoice.stripe_invoice_id,
      hosted_invoice_url: existing.hosted_invoice_url ?? null,
    };
  }

  const customer = await ensureStripeCustomer(stripe, invoice.tenant_id);
  const currency = invoice.currency.toLowerCase();

  // Create the invoice container first (draft state).
  // collection_method='send_invoice' generates a hosted page + email link;
  // 'charge_automatically' would pull the customer's default payment method.
  // Hosted page is the safer default — tenants opt into auto-charge later.
  const stripeInvoice = await stripe.invoices.create(
    {
      customer,
      currency,
      collection_method: 'send_invoice',
      days_until_due: 30,
      metadata: {
        projex_invoice_id: invoice.invoice_id,
        projex_tenant_id: invoice.tenant_id,
        projex_catalog_id: invoice.catalog_id,
      },
      auto_advance: false,
    },
    { idempotencyKey: `invoice-create:${invoice.invoice_id}` },
  );
  if (!stripeInvoice.id) throw new Error('Stripe returned invoice without id');

  // Attach each billable line as a Stripe InvoiceItem on the same invoice.
  // We use the per-line amount (already units * rate) rather than re-pricing
  // through Stripe so the totals match what we audited on finalize.
  for (const line of line_items) {
    const amountMinor = toMinor(line.amount, invoice.currency);
    if (amountMinor === 0) continue;
    await stripe.invoiceItems.create(
      {
        customer,
        invoice: stripeInvoice.id,
        currency,
        amount: amountMinor,
        description: line.sku + (line.app_id ? ` (${line.app_id})` : ''),
        metadata: {
          projex_line_id: line.line_id,
          projex_sku: line.sku,
        },
      },
      { idempotencyKey: `invoice-item:${line.line_id}` },
    );
  }

  // Finalize so the hosted page becomes available + the total locks in.
  const finalized = await stripe.invoices.finalizeInvoice(stripeInvoice.id);
  const finalizedId = finalized.id ?? stripeInvoice.id;

  // Persist the Stripe id back onto our invoice row so the webhook handler
  // can join on it when payment_succeeded fires.
  await dataService.query(
    `UPDATE billing.invoice
        SET stripe_invoice_id = $1
      WHERE invoice_id = $2`,
    [finalizedId, invoice_id],
  );

  return {
    stripe_invoice_id: finalizedId,
    hosted_invoice_url: finalized.hosted_invoice_url ?? null,
  };
}

/**
 * Late-bound hook for sdk-payment's Stripe webhook. When
 * `invoice.payment_succeeded` fires, sdk-payment calls this via the
 * setInvoicePaidHandler injection wired at boot in api-gateway.
 *
 * Idempotent: only flips status when not already 'paid'.
 */
export async function onStripeInvoicePaid(stripe_invoice_id: string): Promise<void> {
  await dataService.query(
    `UPDATE billing.invoice
        SET status = 'paid',
            paid_at = COALESCE(paid_at, now())
      WHERE stripe_invoice_id = $1
        AND status <> 'paid'`,
    [stripe_invoice_id],
  );
}
