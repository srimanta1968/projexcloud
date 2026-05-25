import { randomUUID } from 'crypto';
import { dataService } from '@projexlight/db-runtime';
import { appendAuditEntry } from '@projexlight/sdk-audit';
import type { WatermarkApplicationRef, WatermarkScheme } from '@projexlight/contracts';

/**
 * Server-side intake for watermark applications (FR-WMK / AC-10).
 *
 * Every time the native HDK applies a watermark to an evidence variant
 * (NOT the raw — the raw is never touched per PRD R-6), the device
 * posts the application here. The row carries a `payload_envelope`
 * which is the vault-wrapped record of (a) what was embedded and
 * (b) the cryptographic proof. sdk-evidence's legal-export bundle
 * generator joins on variant_id to surface the watermark chain in the
 * signed PDF + JSONL.
 *
 * Cryptographic-scheme watermarks SHOULD carry a Merkle-leaf proof
 * computed by the device — we do not validate that proof here; the
 * verifyLegalExportBundle() function does on read.
 */

const HDK_WATERMARK_AUDIT_POOL = process.env.HDK_WATERMARK_AUDIT_POOL || 'admin-default';
const MAX_PAYLOAD_BYTES = parseInt(process.env.HDK_WATERMARK_MAX_PAYLOAD_BYTES ?? '16384', 10);

export interface RecordWatermarkApplicationInput {
  variant_id: string;
  scheme: WatermarkScheme;
  /** Vault-wrapped envelope bytes. Either Buffer (preferred) or base64. */
  payload_envelope: Buffer | string;
  /** Optional tenant_id for audit envelope. */
  tenant_id?: string | null;
}

interface ApplicationRow {
  application_id: string;
  variant_id: string;
  scheme: string;
  applied_at: Date;
  payload_envelope: Buffer;
}

function rowToRef(r: ApplicationRow): WatermarkApplicationRef {
  return {
    application_id: r.application_id,
    variant_id: r.variant_id,
    scheme: r.scheme as WatermarkScheme,
    payload_envelope: r.payload_envelope.toString('base64'),
    applied_at: r.applied_at.toISOString(),
  };
}

function coerceEnvelope(payload: Buffer | string): Buffer {
  if (Buffer.isBuffer(payload)) return payload;
  if (typeof payload === 'string') {
    // Accept base64 OR utf8 — base64 wins when the string is pure
    // base64 alphabet, otherwise fall back to utf8 so callers that
    // post readable JSON wraps still work.
    const trimmed = payload.trim();
    const looksLikeBase64 = /^[A-Za-z0-9+/=]+$/.test(trimmed) && trimmed.length % 4 === 0;
    return looksLikeBase64 ? Buffer.from(trimmed, 'base64') : Buffer.from(trimmed, 'utf8');
  }
  throw new Error('[hdk-watermark] payload_envelope must be Buffer or string');
}

function validateInput(input: RecordWatermarkApplicationInput): Buffer {
  if (!input.variant_id) throw new Error('[hdk-watermark] variant_id is required');
  if (!['visible', 'invisible', 'cryptographic'].includes(input.scheme)) {
    throw new Error(`[hdk-watermark] invalid scheme '${input.scheme}'`);
  }
  if (input.payload_envelope == null) {
    throw new Error('[hdk-watermark] payload_envelope is required');
  }
  const buf = coerceEnvelope(input.payload_envelope);
  if (buf.length === 0) {
    throw new Error('[hdk-watermark] payload_envelope is empty');
  }
  if (buf.length > MAX_PAYLOAD_BYTES) {
    throw new Error(
      `[hdk-watermark] payload_envelope size ${buf.length} exceeds limit ${MAX_PAYLOAD_BYTES}`,
    );
  }
  return buf;
}

export async function recordWatermarkApplication(
  input: RecordWatermarkApplicationInput,
): Promise<WatermarkApplicationRef> {
  const envelope = validateInput(input);

  const applicationId = randomUUID();
  const row = await dataService.one<ApplicationRow>(
    `INSERT INTO hdk_watermark.application
       (application_id, variant_id, scheme, payload_envelope)
     VALUES ($1, $2, $3, $4)
     RETURNING application_id, variant_id, scheme, applied_at, payload_envelope`,
    [applicationId, input.variant_id, input.scheme, envelope],
  );
  if (!row) throw new Error('[hdk-watermark] insert failed');

  try {
    await appendAuditEntry({
      pool_index: HDK_WATERMARK_AUDIT_POOL,
      event_type: 'hdk-watermark.applied.v1',
      actor_kind: 'service',
      actor_id: 'hdk-watermark',
      tenant_id: input.tenant_id ?? null,
      subject_kind: 'hdk_watermark.application',
      subject_id: applicationId,
      retention_class: 'regulated',
      payload: {
        application_id: applicationId,
        variant_id: input.variant_id,
        scheme: input.scheme,
        payload_size_bytes: envelope.length,
      },
    });
  } catch (err) {
    console.warn('[hdk-watermark] audit emit failed (non-fatal):', (err as Error).message);
  }

  return rowToRef(row);
}

export async function getWatermarkApplication(application_id: string): Promise<WatermarkApplicationRef | null> {
  const row = await dataService.one<ApplicationRow>(
    `SELECT application_id, variant_id, scheme, applied_at, payload_envelope
       FROM hdk_watermark.application WHERE application_id = $1`,
    [application_id],
  );
  return row ? rowToRef(row) : null;
}

export async function listWatermarkApplicationsForVariant(
  variant_id: string,
): Promise<WatermarkApplicationRef[]> {
  const rows = await dataService.rows<ApplicationRow>(
    `SELECT application_id, variant_id, scheme, applied_at, payload_envelope
       FROM hdk_watermark.application
      WHERE variant_id = $1
      ORDER BY applied_at DESC`,
    [variant_id],
  );
  return rows.map(rowToRef);
}
