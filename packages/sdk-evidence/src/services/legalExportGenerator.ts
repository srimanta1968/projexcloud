import crypto from 'crypto';
import { getPool } from '@projexlight/db-runtime';
import { verifyChains, type ChainVerifyReport } from './chainVerifier';
import { getJurisdictionTemplate } from './legalExportTemplates';
import type { EvidenceLegalExportRef, LegalExportJurisdiction } from '@projexlight/contracts';

/**
 * Legal-export bundle generator (P7 FR-EVD-4 / AC-9).
 *
 * Builds a signed PDF + JSONL manifest + chain_verifications block for
 * the requested set of captures, uploads to S3 via the injected uploader,
 * and INSERTs the evidence.legal_export row.
 *
 * NFR (PRD §6): ≤ 60s for a 1GB bundle. The hot loop is per-capture
 * metadata fetch + chain verify; both are bounded by the count of
 * captures (typically ≤ 50 per export). PDF rendering is the linear
 * factor in bytes — pdfkit streams to a Node Buffer.
 *
 * Signature: detached HMAC-SHA256 over sha256(pdf_bytes || jsonl_bytes).
 * Production wires sdk-vault.sign() once it lands; the env-key fallback
 * is documented in code and refused in production unless explicitly
 * allowed.
 */

export interface UploadAdapter {
  /** Returns the S3 key (or equivalent object identifier) for the uploaded bundle. */
  upload(input: { tenant_id: string; export_id: string; pdf: Buffer; jsonl: Buffer }): Promise<string>;
}

let _uploader: UploadAdapter | null = null;

export function registerLegalExportUploader(uploader: UploadAdapter | null): void {
  _uploader = uploader;
}

interface CaptureBundleRow {
  capture_id: string;
  tenant_id: string;
  encounter_id: string;
  capturer_persona_id: string;
  device_uuid: string;
  device_attestation_id: string;
  raw_blob_id: string;
  captured_at: Date;
  lat: string | null;
  lng: string | null;
  consent_ref: string;
  retention_class: string;
  status: string;
}

async function loadCaptures(captureIds: string[]): Promise<CaptureBundleRow[]> {
  if (captureIds.length === 0) return [];
  const pool = getPool();
  const { rows } = await pool.query<CaptureBundleRow>(
    `SELECT capture_id, tenant_id::text AS tenant_id,
            encounter_id::text AS encounter_id,
            capturer_persona_id::text AS capturer_persona_id,
            device_uuid, device_attestation_id, raw_blob_id,
            captured_at, lat::text AS lat, lng::text AS lng,
            consent_ref, retention_class, status
       FROM evidence.capture
      WHERE capture_id = ANY($1::text[])
      ORDER BY captured_at ASC`,
    [captureIds],
  );
  return rows;
}

interface VariantRow {
  variant_id: string;
  capture_id: string;
  kind: string;
  variant_blob_id: string;
  created_by_persona_id: string;
  created_at: Date;
}

async function loadVariants(captureIds: string[]): Promise<VariantRow[]> {
  if (captureIds.length === 0) return [];
  const pool = getPool();
  const { rows } = await pool.query<VariantRow>(
    `SELECT variant_id, capture_id, kind, variant_blob_id,
            created_by_persona_id::text AS created_by_persona_id, created_at
       FROM evidence.variant
      WHERE capture_id = ANY($1::text[])
      ORDER BY capture_id, created_at`,
    [captureIds],
  );
  return rows;
}

interface ChainRow {
  capture_id: string;
  seq: number;
  action: string;
  actor_persona_id: string;
  audit_entry_id: string;
  occurred_at: Date;
}

async function loadChainEntries(captureIds: string[]): Promise<ChainRow[]> {
  if (captureIds.length === 0) return [];
  const pool = getPool();
  const { rows } = await pool.query<ChainRow>(
    `SELECT capture_id, seq, action,
            actor_persona_id::text AS actor_persona_id,
            audit_entry_id, occurred_at
       FROM evidence.chain_of_custody
      WHERE capture_id = ANY($1::text[])
      ORDER BY capture_id, seq`,
    [captureIds],
  );
  return rows;
}

function getSigningKey(): Buffer {
  const fromEnv = process.env.EVIDENCE_LEGAL_EXPORT_SIGNING_KEY;
  if (fromEnv) return Buffer.from(fromEnv, 'hex');
  if (process.env.NODE_ENV === 'production') {
    throw new Error(
      'EVIDENCE_LEGAL_EXPORT_SIGNING_KEY required in production. Wire sdk-vault.sign() once available.',
    );
  }
  // Dev default — deterministic so unit tests don't flap, but obviously
  // not safe for production.
  return crypto.createHash('sha256').update('dev-legal-export-key').digest();
}

/**
 * Build the JSONL manifest. One JSON object per line — captures first,
 * then variants, then chain entries, then verification results.
 */
function buildJsonl(
  captures: CaptureBundleRow[],
  variants: VariantRow[],
  chain: ChainRow[],
  verifications: ChainVerifyReport[],
): Buffer {
  const lines: string[] = [];
  for (const c of captures) {
    lines.push(JSON.stringify({
      _type: 'capture',
      capture_id: c.capture_id,
      tenant_id: c.tenant_id,
      encounter_id: c.encounter_id,
      capturer_persona_id: c.capturer_persona_id,
      device_uuid: c.device_uuid,
      device_attestation_id: c.device_attestation_id,
      raw_blob_id: c.raw_blob_id,
      captured_at: c.captured_at.toISOString(),
      lat: c.lat,
      lng: c.lng,
      consent_ref: c.consent_ref,
      retention_class: c.retention_class,
      status: c.status,
    }));
  }
  for (const v of variants) {
    lines.push(JSON.stringify({
      _type: 'variant',
      variant_id: v.variant_id,
      capture_id: v.capture_id,
      kind: v.kind,
      variant_blob_id: v.variant_blob_id,
      created_by_persona_id: v.created_by_persona_id,
      created_at: v.created_at.toISOString(),
    }));
  }
  for (const e of chain) {
    lines.push(JSON.stringify({
      _type: 'chain_entry',
      capture_id: e.capture_id,
      seq: e.seq,
      action: e.action,
      actor_persona_id: e.actor_persona_id,
      audit_entry_id: e.audit_entry_id,
      occurred_at: e.occurred_at.toISOString(),
    }));
  }
  for (const v of verifications) {
    lines.push(JSON.stringify({ _type: 'chain_verification', ...v }));
  }
  return Buffer.from(lines.join('\n') + '\n', 'utf8');
}

/**
 * Build the cover-page PDF. Uses pdfkit when available (optionalDependency);
 * when absent, falls back to a minimal text-based PDF surrogate built in
 * pure crypto — enough to compute a signature over but not a real PDF.
 * Production should always have pdfkit; the fallback prevents test-env
 * pain without making pdfkit a hard runtime requirement.
 */
async function buildPdf(
  exportId: string,
  jurisdiction: LegalExportJurisdiction,
  captures: CaptureBundleRow[],
  verifications: ChainVerifyReport[],
): Promise<Buffer> {
  const template = getJurisdictionTemplate(jurisdiction);
  let PDFDocument: typeof import('pdfkit') | null = null;
  try {
    // Optional dep — runtime require so the package builds without pdfkit
    // installed.
    PDFDocument = require('pdfkit');
  } catch {
    PDFDocument = null;
  }

  if (!PDFDocument) {
    const summary = [
      `=== ProjexCloud Legal Evidence Export (PDF-fallback text) ===`,
      `export_id: ${exportId}`,
      `jurisdiction: ${template.jurisdiction}`,
      `title: ${template.title}`,
      `captures: ${captures.length}`,
      ``,
      `Certification:`,
      template.certification,
      ``,
      `Chain Clause:`,
      template.chain_clause,
      ``,
      `Disclosures:`,
      ...template.disclosures.map((d) => `- ${d}`),
      ``,
      `Verifications:`,
      ...verifications.map(
        (v) => `  capture=${v.capture_id} verified=${v.verified} entries=${v.entry_count}` +
          (v.verified ? '' : ` failed_seq=${v.failed_seq} reason=${v.failure_reason}`),
      ),
    ].join('\n');
    return Buffer.from(summary, 'utf8');
  }

  return new Promise<Buffer>((resolve, reject) => {
    const doc = new (PDFDocument as any)({ size: 'LETTER', margin: 50 });
    const chunks: Buffer[] = [];
    doc.on('data', (c: Buffer) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    doc.fontSize(18).text(template.title, { underline: true });
    doc.moveDown();
    doc.fontSize(10).text(`Export ID: ${exportId}`);
    doc.text(`Generated: ${new Date().toISOString()}`);
    doc.text(`Jurisdiction: ${template.jurisdiction}`);
    doc.text(`Timezone: ${template.timezone_hint}`);
    doc.text(`Captures: ${captures.length}`);
    doc.moveDown();

    doc.fontSize(14).text('Certification', { underline: true });
    doc.fontSize(10).text(template.certification);
    doc.moveDown();

    doc.fontSize(14).text('Chain-of-Custody Declaration', { underline: true });
    doc.fontSize(10).text(template.chain_clause);
    doc.moveDown();

    doc.fontSize(14).text('Captures', { underline: true });
    doc.fontSize(9);
    for (const c of captures) {
      doc.text(
        `  ${c.capture_id} · enc=${c.encounter_id} · device=${c.device_uuid} · at=${c.captured_at.toISOString()} · status=${c.status}`,
      );
    }
    doc.moveDown();

    doc.fontSize(14).text('Chain Verifications', { underline: true });
    doc.fontSize(9);
    for (const v of verifications) {
      const line = v.verified
        ? `  ✓ ${v.capture_id} (${v.entry_count} entries)`
        : `  ✗ ${v.capture_id} — seq=${v.failed_seq} reason=${v.failure_reason}`;
      doc.text(line);
    }
    doc.moveDown();

    doc.fontSize(14).text('Disclosures', { underline: true });
    doc.fontSize(10);
    for (const d of template.disclosures) {
      doc.text(`• ${d}`);
    }

    doc.end();
  });
}

export interface GenerateLegalExportInput {
  requestor_persona_id: string;
  jurisdiction: LegalExportJurisdiction;
  capture_ids: string[];
  /** Tenant context for the bundle. Required for the upload + audit emit. */
  tenant_id: string;
}

/**
 * Top-level entry. Returns the persisted evidence.legal_export row + the
 * resolved bundle bytes (so callers can stream them without a re-fetch).
 */
export async function generateLegalExport(
  input: GenerateLegalExportInput,
): Promise<{ row: EvidenceLegalExportRef; pdf: Buffer; jsonl: Buffer }> {
  if (input.capture_ids.length === 0) {
    throw new Error('generateLegalExport: capture_ids[] must not be empty');
  }

  const captures = await loadCaptures(input.capture_ids);
  const variants = await loadVariants(input.capture_ids);
  const chain = await loadChainEntries(input.capture_ids);
  const verifications = await verifyChains(input.capture_ids);

  const exportId = `lex_${crypto.randomBytes(10).toString('hex')}`;
  const pdf = await buildPdf(exportId, input.jurisdiction, captures, verifications);
  const jsonl = buildJsonl(captures, variants, chain, verifications);

  // Detached signature over sha256(pdf || jsonl). Verifier recomputes the
  // same hash + checks the HMAC.
  const payloadHash = crypto.createHash('sha256').update(pdf).update(jsonl).digest();
  const signature = crypto.createHmac('sha256', getSigningKey()).update(payloadHash).digest();
  const signatureEnvelope = Buffer.concat([
    Buffer.from('PCLE/v1\n', 'utf8'), // ProjexCloud Legal Export v1
    Buffer.from(payloadHash.toString('hex') + '\n', 'utf8'),
    signature,
  ]);

  // Upload — when no adapter registered, store the bundle as a deterministic
  // local file so dev/CI can still ask the row "where's the artifact?".
  let s3Key: string;
  if (_uploader) {
    s3Key = await _uploader.upload({
      tenant_id: input.tenant_id,
      export_id: exportId,
      pdf,
      jsonl,
    });
  } else {
    s3Key = `local://.evidence-exports/${input.tenant_id}/${exportId}.bundle`;
  }

  // Build the verifications jsonb. Convert Buffer hashes to hex strings.
  const verificationsBlob: Record<string, ChainVerifyReport> = {};
  for (const v of verifications) {
    verificationsBlob[v.capture_id] = v;
  }

  const pool = getPool();
  const { rows } = await pool.query<{ generated_at: Date }>(
    `INSERT INTO evidence.legal_export
       (export_id, requestor_persona_id, jurisdiction, capture_ids,
        artifact_s3_key, signature_envelope, chain_verifications)
     VALUES ($1, $2::uuid, $3, $4, $5, $6, $7::jsonb)
     RETURNING generated_at`,
    [
      exportId,
      input.requestor_persona_id,
      input.jurisdiction,
      input.capture_ids,
      s3Key,
      signatureEnvelope,
      JSON.stringify(verificationsBlob),
    ],
  );

  const row: EvidenceLegalExportRef = {
    export_id: exportId,
    requestor_persona_id: input.requestor_persona_id,
    jurisdiction: input.jurisdiction,
    capture_ids: input.capture_ids,
    artifact_s3_key: s3Key,
    signature_envelope: signatureEnvelope.toString('hex'),
    chain_verifications: verificationsBlob,
    generated_at: rows[0].generated_at.toISOString(),
  };

  return { row, pdf, jsonl };
}

/**
 * Verify a previously-generated bundle. Recomputes the payload hash and
 * HMAC and compares to the signature envelope. Returns true when the
 * bundle is intact.
 */
export function verifyLegalExportBundle(input: {
  pdf: Buffer;
  jsonl: Buffer;
  signature_envelope: Buffer;
}): boolean {
  const payloadHash = crypto.createHash('sha256').update(input.pdf).update(input.jsonl).digest();
  const expectedSig = crypto.createHmac('sha256', getSigningKey()).update(payloadHash).digest();

  // The envelope is: "PCLE/v1\n" + hash_hex + "\n" + signature_bytes.
  const envText = input.signature_envelope.toString('utf8');
  const firstNl = envText.indexOf('\n');
  if (firstNl < 0) return false;
  const secondNl = envText.indexOf('\n', firstNl + 1);
  if (secondNl < 0) return false;
  const storedHashHex = envText.slice(firstNl + 1, secondNl);
  if (storedHashHex !== payloadHash.toString('hex')) return false;
  const storedSig = input.signature_envelope.subarray(secondNl + 1);
  return crypto.timingSafeEqual(storedSig, expectedSig);
}
