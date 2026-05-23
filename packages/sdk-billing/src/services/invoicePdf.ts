/// <reference types="pdfkit" />
import { dataService } from '@projexlight/db-runtime';
import type { InvoiceRecord, LineItemRecord } from '../models/billing.model';

// pdfkit is loaded lazily so dev environments without the dep can still
// import sdk-billing. The @types/pdfkit declarations export `var doc:
// PDFKit.PDFDocument` (an instance), so we cast the require() to a
// constructor signature the rest of the code can `new` from.
type PDFDocumentCtor = new (opts?: PDFKit.PDFDocumentOptions) => PDFKit.PDFDocument;
let cachedCtor: PDFDocumentCtor | null = null;
function getPdfDocumentCtor(): PDFDocumentCtor {
  if (cachedCtor) return cachedCtor;
  cachedCtor = require('pdfkit') as PDFDocumentCtor;
  return cachedCtor;
}

/**
 * Invoice PDF generator per FR-BIL-2 (rendering side).
 *
 * Pure render layer: builds a pdfkit document from an InvoiceRecord + its
 * line items + the tenant display name. Returns a Buffer the caller can
 * stream to S3 or hand to email.
 *
 * The S3 upload is intentionally late-bound — production wires an uploader
 * via setInvoicePdfUploader; default is a noop returning null so unit tests
 * stay self-contained.
 */

export type InvoicePdfUploader = (
  pdf: Buffer,
  invoice_id: string,
) => Promise<string | null>;

const NOOP_UPLOADER: InvoicePdfUploader = async () => null;

let activeUploader: InvoicePdfUploader = NOOP_UPLOADER;

export function setInvoicePdfUploader(uploader: InvoicePdfUploader): void {
  activeUploader = uploader;
}

export function getInvoicePdfUploader(): InvoicePdfUploader {
  return activeUploader;
}

export interface GenerateAndUploadResult {
  s3_key: string | null;
  size_bytes: number;
}

/**
 * Pure PDF render. Header (company + invoice metadata), table body
 * (sku × dims × qty × rate × amount), footer (subtotal, tax, total).
 */
export async function generateInvoicePdf(
  invoice: InvoiceRecord,
  line_items: LineItemRecord[],
  tenant_name: string,
): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    try {
      const Ctor = getPdfDocumentCtor();
      const doc = new Ctor({ margin: 50, size: 'A4' });
      const chunks: Buffer[] = [];
      doc.on('data', (chunk: Buffer) => chunks.push(chunk));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);

      renderHeader(doc, invoice, tenant_name);
      renderLineItemsTable(doc, line_items);
      renderFooter(doc, invoice);

      doc.end();
    } catch (err) {
      reject(err);
    }
  });
}

function renderHeader(
  doc: PDFKit.PDFDocument,
  invoice: InvoiceRecord,
  tenant_name: string,
): void {
  doc
    .fontSize(20)
    .font('Helvetica-Bold')
    .text(tenant_name, { align: 'left' })
    .moveDown(0.3);

  doc
    .fontSize(16)
    .font('Helvetica-Bold')
    .text('INVOICE', { align: 'right' });

  doc.moveDown(0.5);

  doc
    .fontSize(10)
    .font('Helvetica')
    .text(`Invoice #: ${invoice.invoice_id}`)
    .text(`Period: ${invoice.period_start} — ${invoice.period_end}`)
    .text(`Status: ${invoice.status.toUpperCase()}`)
    .text(`Currency: ${invoice.currency}`);

  if (invoice.generated_at) {
    const issued = invoice.generated_at instanceof Date
      ? invoice.generated_at.toISOString().slice(0, 10)
      : String(invoice.generated_at).slice(0, 10);
    doc.text(`Issued: ${issued}`);
  }

  doc.moveDown(1);
  doc
    .moveTo(50, doc.y)
    .lineTo(545, doc.y)
    .stroke();
  doc.moveDown(0.5);
}

function renderLineItemsTable(
  doc: PDFKit.PDFDocument,
  line_items: LineItemRecord[],
): void {
  const colX = { sku: 50, dims: 180, qty: 340, rate: 410, amount: 480 };
  const headerY = doc.y;

  doc
    .fontSize(10)
    .font('Helvetica-Bold')
    .text('SKU', colX.sku, headerY)
    .text('Dimensions', colX.dims, headerY)
    .text('Qty', colX.qty, headerY, { width: 60, align: 'right' })
    .text('Rate', colX.rate, headerY, { width: 60, align: 'right' })
    .text('Amount', colX.amount, headerY, { width: 60, align: 'right' });

  doc.moveDown(0.5);
  doc
    .moveTo(50, doc.y)
    .lineTo(545, doc.y)
    .stroke();
  doc.moveDown(0.3);

  doc.font('Helvetica').fontSize(9);

  for (const line of line_items) {
    if (doc.y > 720) {
      doc.addPage();
    }
    const rowY = doc.y;
    const dimsLabel = formatDimensions(line);

    doc
      .text(line.sku, colX.sku, rowY, { width: 125 })
      .text(dimsLabel, colX.dims, rowY, { width: 155 })
      .text(line.units, colX.qty, rowY, { width: 60, align: 'right' })
      .text(line.rate, colX.rate, rowY, { width: 60, align: 'right' })
      .text(line.amount, colX.amount, rowY, { width: 60, align: 'right' });

    // Push y down to the tallest column written in this row.
    doc.moveDown(0.5);
  }

  doc.moveDown(0.5);
  doc
    .moveTo(50, doc.y)
    .lineTo(545, doc.y)
    .stroke();
  doc.moveDown(0.5);
}

function formatDimensions(line: LineItemRecord): string {
  const parts: string[] = [];
  if (line.app_id) parts.push(`app=${line.app_id}`);
  if (line.bu_id) parts.push(`bu=${line.bu_id}`);
  if (line.persona_kind) parts.push(`persona=${line.persona_kind}`);
  if (line.encounter_id) parts.push(`enc=${line.encounter_id}`);
  if (line.actor_kind) parts.push(`actor=${line.actor_kind}`);
  return parts.length > 0 ? parts.join(' · ') : '—';
}

function renderFooter(doc: PDFKit.PDFDocument, invoice: InvoiceRecord): void {
  const labelX = 380;
  const valueX = 480;

  doc.fontSize(10).font('Helvetica');
  let y = doc.y;
  doc.text('Subtotal', labelX, y, { width: 90, align: 'right' });
  doc.text(invoice.subtotal, valueX, y, { width: 60, align: 'right' });

  doc.moveDown(0.4);
  y = doc.y;
  doc.text('Tax', labelX, y, { width: 90, align: 'right' });
  doc.text(invoice.tax, valueX, y, { width: 60, align: 'right' });

  doc.moveDown(0.4);
  y = doc.y;
  doc
    .font('Helvetica-Bold')
    .text(`Total (${invoice.currency})`, labelX, y, { width: 90, align: 'right' })
    .text(invoice.total, valueX, y, { width: 60, align: 'right' });
}

/**
 * Production-side helper: load invoice + line items, render, hand to the
 * registered uploader, and persist the resulting s3_key back to
 * billing.invoice.pdf_s3_key when the uploader produced one.
 */
export async function generateAndUploadPdf(invoice_id: string): Promise<GenerateAndUploadResult> {
  const invoice = await dataService.one<InvoiceRecord>(
    `SELECT invoice_id, tenant_id, catalog_id, fiscal_period_id,
            period_start, period_end, subtotal, tax, total, currency,
            status, pdf_s3_key, stripe_invoice_id,
            generated_at, finalized_at, paid_at
       FROM billing.invoice
      WHERE invoice_id = $1`,
    [invoice_id],
  );
  if (!invoice) {
    throw new Error(`Invoice ${invoice_id} not found`);
  }

  const line_items = await dataService.rows<LineItemRecord>(
    `SELECT line_id, invoice_id, sku, app_id, bu_id, persona_kind,
            encounter_id, units, rate, amount, actor_kind
       FROM billing.line_item
      WHERE invoice_id = $1
      ORDER BY line_id ASC`,
    [invoice_id],
  );

  const tenantRow = await dataService.one<{ name: string | null }>(
    `SELECT name FROM tenant.tenant WHERE tenant_id = $1`,
    [invoice.tenant_id],
  ).catch(() => null);
  const tenant_name = tenantRow?.name ?? invoice.tenant_id;

  const pdf = await generateInvoicePdf(invoice, line_items, tenant_name);
  const s3_key = await activeUploader(pdf, invoice_id);

  if (s3_key) {
    await dataService.query(
      `UPDATE billing.invoice SET pdf_s3_key = $1 WHERE invoice_id = $2`,
      [s3_key, invoice_id],
    );
  }

  return { s3_key, size_bytes: pdf.length };
}
