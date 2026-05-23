import { dataService } from '@projexlight/db-runtime';
import { appendAuditEntry } from '@projexlight/sdk-audit';
import { applyRate, loadCatalogRates } from './rateEngine';
import { getUsageReader } from './usageReader';
import { applyFreeTier } from './freeTierEngine';
import type {
  GenerateInvoiceInput,
  InvoiceRecord,
  LineItemRecord,
  UsageBucket,
} from '../models/billing.model';

/**
 * Invoice generator per FR-BIL-2.
 *
 * Pipeline:
 *   1. Read usage buckets from ClickHouse (or synthetic Postgres rollup)
 *   2. Apply free-tier deductions (FR-BIL-3)
 *   3. Load catalog rates and apply per-bucket pricing mode (FR-BIL-1)
 *   4. Persist invoice + line_item rows
 *   5. Emit billing.invoice.finalized.v1 envelope via sdk-audit chain
 *
 * The catalog_id stays pinned on the invoice forever, making the line items
 * reproducible — re-running with the same usage + catalog yields the same
 * amounts (key reprice-dry-run guarantee).
 *
 * PDF rendering and Stripe push are deliberately deferred to keep this
 * service synchronous and unit-testable; production wires them in via
 * post-finalize hooks.
 */

export class CatalogNotFoundError extends Error {
  readonly code = 'CatalogNotFound';
  constructor(catalog_id: string) { super(`Pricing catalog ${catalog_id} not found`); }
}

export interface GenerateInvoiceResult {
  invoice: InvoiceRecord;
  line_items: LineItemRecord[];
}

export async function generateInvoice(
  input: GenerateInvoiceInput,
): Promise<GenerateInvoiceResult> {
  const rates = await loadCatalogRates(input.catalog_id);
  if (rates.size === 0) throw new CatalogNotFoundError(input.catalog_id);

  const usage = input.usage ?? await getUsageReader().readUsage({
    tenant_id: input.tenant_id,
    period_start: input.period_start,
    period_end: input.period_end,
  });

  // Apply free-tier deductions before pricing (FR-BIL-3).
  const billable = await applyFreeTier(input.tenant_id, usage);

  // Price each bucket independently to preserve showback dimensions.
  const linesToInsert: Array<Omit<LineItemRecord, 'line_id' | 'invoice_id'>> = [];
  let subtotal = 0;
  for (const bucket of billable) {
    const rate = rates.get(bucket.sku);
    if (!rate) continue; // unmetered SKU - skip silently
    const applied = applyRate(rate, bucket);
    if (applied.amount === 0 && rate.mode !== 'bundled_subscription') continue;
    subtotal += applied.amount;
    linesToInsert.push({
      sku: bucket.sku,
      app_id: bucket.app_id,
      bu_id: bucket.bu_id,
      persona_kind: bucket.persona_kind,
      encounter_id: bucket.encounter_id,
      units: String(bucket.units),
      rate: String(applied.rate),
      amount: String(applied.amount),
      actor_kind: bucket.actor_kind,
    });
  }

  const tax_rate = input.tax_rate ?? 0;
  const tax = round4(subtotal * tax_rate);
  const total = round4(subtotal + tax);

  const invoiceRows = await dataService.rows<InvoiceRecord>(
    `INSERT INTO billing.invoice (
       tenant_id, catalog_id, period_start, period_end,
       subtotal, tax, total, currency, status
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'finalized')
     RETURNING invoice_id, tenant_id, catalog_id, fiscal_period_id,
               period_start, period_end, subtotal, tax, total, currency,
               status, pdf_s3_key, stripe_invoice_id,
               generated_at, finalized_at, paid_at`,
    [
      input.tenant_id,
      input.catalog_id,
      input.period_start,
      input.period_end,
      String(round4(subtotal)),
      String(tax),
      String(total),
      input.currency ?? 'USD',
    ],
  );
  const invoice = invoiceRows[0];

  await dataService.query(
    `UPDATE billing.invoice SET finalized_at = now() WHERE invoice_id = $1`,
    [invoice.invoice_id],
  );

  const line_items: LineItemRecord[] = [];
  for (const line of linesToInsert) {
    const rows = await dataService.rows<LineItemRecord>(
      `INSERT INTO billing.line_item (
         invoice_id, sku, app_id, bu_id, persona_kind, encounter_id,
         units, rate, amount, actor_kind
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       RETURNING line_id, invoice_id, sku, app_id, bu_id, persona_kind,
                 encounter_id, units, rate, amount, actor_kind`,
      [
        invoice.invoice_id,
        line.sku,
        line.app_id,
        line.bu_id,
        line.persona_kind,
        line.encounter_id,
        line.units,
        line.rate,
        line.amount,
        line.actor_kind,
      ],
    );
    line_items.push(rows[0]);
  }

  // Audit-chain envelope so the finalize is hash-linked + tamper-evident.
  await appendAuditEntry({
    pool_index: 'admin',
    event_type: 'billing.invoice.finalized.v1',
    tenant_id: input.tenant_id,
    actor_kind: 'service',
    actor_id: 'sdk-billing',
    subject_kind: 'invoice',
    subject_id: invoice.invoice_id,
    payload: {
      invoice_id: invoice.invoice_id,
      catalog_id: invoice.catalog_id,
      period_start: invoice.period_start,
      period_end: invoice.period_end,
      subtotal: invoice.subtotal,
      total: invoice.total,
      currency: invoice.currency,
      line_count: line_items.length,
    },
  });

  // FR-BIL-2 + FR-BIL-8: post-finalize hooks fan out to PDF generation +
  // Stripe push (registered at boot). Best-effort; finalize never blocks.
  await runPostFinalizeHooks({ invoice, line_items });

  return { invoice, line_items };
}

function round4(n: number): number { return Math.round(n * 10_000) / 10_000; }

/* ----------------------------------------- post-finalize hooks (PDF + Stripe push) */

/**
 * Post-finalize hooks. After billing.invoice is written + audit-chained,
 * we fan out to optional registered consumers:
 *   - PDF generator: produces the invoice PDF + uploads (invoicePdf.ts)
 *   - Stripe pusher: pushes the invoice to Stripe for collection (stripeInvoicePush.ts)
 * Each hook is registered at api-gateway boot via setPostFinalizeHook. Failures
 * are swallowed (best-effort) so the finalize transaction is never blocked by
 * an out-of-band hook outage.
 */
export type PostFinalizeHook = (args: {
  invoice: InvoiceRecord;
  line_items: LineItemRecord[];
}) => Promise<void>;

const postFinalizeHooks: PostFinalizeHook[] = [];

export function registerPostFinalizeHook(hook: PostFinalizeHook): void {
  postFinalizeHooks.push(hook);
}

export async function runPostFinalizeHooks(args: {
  invoice: InvoiceRecord;
  line_items: LineItemRecord[];
}): Promise<void> {
  for (const hook of postFinalizeHooks) {
    try { await hook(args); }
    catch (err) {
      console.error('[sdk-billing] post-finalize hook failed:', (err as Error).message);
    }
  }
}
