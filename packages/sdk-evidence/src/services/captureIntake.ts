import crypto from 'crypto';
import { dataService } from '@projexlight/db-runtime';
import { appendAuditEntry } from '@projexlight/sdk-audit';
import type {
  EvidenceCaptureRef,
  EvidenceCaptureStatus,
} from '@projexlight/contracts';
import { appendChainEntry } from './chainAppender';
import { assertEncounterNotSealed } from './sealGuard';

/**
 * Provenance-stamped capture intake (P7 FR-EVD-1 / AC-1).
 *
 * This is the entry point HDK posts to after a photo/video lands in
 * sdk-media. The handler:
 *
 *   1. Pre-flight: assert the encounter is NOT sealed (FR-EVD-5).
 *      The DB trigger from migration 002 catches it too, but the
 *      pre-flight gives the client a clean 409 before the row is
 *      attempted.
 *   2. INSERT evidence.capture with the full provenance tuple
 *      (GPS · IMU · device · attestation · consent · encounter).
 *   3. Emit evidence.captured.v1 to sdk-audit. The audit row's
 *      entry_id becomes the chain-of-custody anchor.
 *   4. Append the first chain_of_custody row (seq=0, action='captured').
 *      The audit_entry_id from step 3 wires the two chains together.
 *
 * Steps 2–4 are not transactional with step 1 because sdk-audit lives
 * in a different schema (and often a different pool); the chain
 * verifier surfaces any orphans (audit row but no chain row, or
 * vice-versa) as `gap` failures so the chain stays attestable.
 *
 * NFR (PRD §6): capture intake p99 ≤ 500ms excluding network. The
 * heavy lift (blob upload, transcode) happens in sdk-media before
 * this call.
 */

const EVIDENCE_AUDIT_POOL = process.env.EVIDENCE_AUDIT_POOL || 'admin-default';
const DEFAULT_RETENTION_CLASS = process.env.EVIDENCE_DEFAULT_RETENTION_CLASS ?? 'regulated';

export interface CaptureEvidenceInput {
  tenant_id: string;
  encounter_id: string;
  capturer_persona_id: string;
  device_uuid: string;
  /** Vault-issued attestation id proving the device is who it says it is. */
  device_attestation_id: string;
  /** media.blob id pointing at the raw upload — never overwritten (FR-EVD-2). */
  raw_blob_id: string;
  /** SHA-256 of the raw blob (hex or Buffer). Becomes chain seq=0's hash. */
  blob_checksum: string | Buffer;
  captured_at: string;
  lat?: number | null;
  lng?: number | null;
  altitude?: number | null;
  /** Optional IMU signature (base64 or Buffer). */
  imu_signature?: string | Buffer | null;
  /** sdk-consent receipt id covering the capture purpose. */
  consent_ref: string;
  retention_class?: string;
  /** When set, retention shredder will mark this row 'shredded' after this point. */
  retention_expires_at?: string | null;
}

export interface CaptureEvidenceResult {
  capture: EvidenceCaptureRef;
  chain_entry_id: string;
  chain_seq: number;
}

interface CaptureRow {
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
  altitude: string | null;
  imu_signature: Buffer | null;
  consent_ref: string;
  retention_class: string;
  retention_expires_at: Date | null;
  status: string;
}

function rowToRef(r: CaptureRow): EvidenceCaptureRef {
  return {
    capture_id: r.capture_id,
    tenant_id: r.tenant_id,
    encounter_id: r.encounter_id,
    capturer_persona_id: r.capturer_persona_id,
    device_uuid: r.device_uuid,
    device_attestation_id: r.device_attestation_id,
    raw_blob_id: r.raw_blob_id,
    captured_at: r.captured_at.toISOString(),
    lat: r.lat == null ? null : Number(r.lat),
    lng: r.lng == null ? null : Number(r.lng),
    altitude: r.altitude == null ? null : Number(r.altitude),
    imu_signature: r.imu_signature ? r.imu_signature.toString('base64') : null,
    consent_ref: r.consent_ref,
    retention_class: r.retention_class,
    retention_expires_at: r.retention_expires_at ? r.retention_expires_at.toISOString() : null,
    status: r.status as EvidenceCaptureStatus,
  };
}

function coerceChecksum(input: string | Buffer): Buffer {
  if (Buffer.isBuffer(input)) {
    if (input.length !== 32) {
      throw new Error('[sdk-evidence] blob_checksum Buffer must be 32 bytes (SHA-256)');
    }
    return input;
  }
  const hex = input.replace(/^0x/, '').trim();
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) {
    throw new Error('[sdk-evidence] blob_checksum string must be 64 hex chars (SHA-256)');
  }
  return Buffer.from(hex, 'hex');
}

function coerceImu(input: string | Buffer | null | undefined): Buffer | null {
  if (input == null) return null;
  if (Buffer.isBuffer(input)) return input;
  // Try base64 then utf8 — same convention as hdk-watermark.
  const trimmed = input.trim();
  if (trimmed.length === 0) return null;
  if (/^[A-Za-z0-9+/=]+$/.test(trimmed) && trimmed.length % 4 === 0) {
    return Buffer.from(trimmed, 'base64');
  }
  return Buffer.from(trimmed, 'utf8');
}

function validateInput(input: CaptureEvidenceInput): void {
  const required: Array<keyof CaptureEvidenceInput> = [
    'tenant_id',
    'encounter_id',
    'capturer_persona_id',
    'device_uuid',
    'device_attestation_id',
    'raw_blob_id',
    'consent_ref',
    'captured_at',
  ];
  for (const f of required) {
    if (!input[f]) throw new Error(`[sdk-evidence] ${String(f)} is required`);
  }
  if (Number.isNaN(new Date(input.captured_at).getTime())) {
    throw new Error('[sdk-evidence] captured_at must be a valid ISO 8601 timestamp');
  }
  if (input.lat != null && (input.lat < -90 || input.lat > 90)) {
    throw new Error('[sdk-evidence] lat must be in [-90, 90]');
  }
  if (input.lng != null && (input.lng < -180 || input.lng > 180)) {
    throw new Error('[sdk-evidence] lng must be in [-180, 180]');
  }
}

/**
 * Capture intake. Returns the persisted capture row + the first chain
 * entry's id/seq so callers can immediately chain into legal-export
 * generation without a second SELECT.
 */
export async function captureEvidence(input: CaptureEvidenceInput): Promise<CaptureEvidenceResult> {
  validateInput(input);
  const checksum = coerceChecksum(input.blob_checksum);
  const imu = coerceImu(input.imu_signature);

  // 1. Pre-flight: encounter not sealed.
  await assertEncounterNotSealed(input.encounter_id);

  // 2. Insert the capture row.
  const captureId = `cap_${crypto.randomBytes(10).toString('hex')}`;
  const row = await dataService.one<CaptureRow>(
    `INSERT INTO evidence.capture
       (capture_id, tenant_id, encounter_id, capturer_persona_id, device_uuid,
        device_attestation_id, raw_blob_id, captured_at, lat, lng, altitude,
        imu_signature, consent_ref, retention_class, retention_expires_at)
     VALUES ($1, $2::uuid, $3::uuid, $4::uuid, $5, $6, $7, $8,
             $9, $10, $11, $12, $13, $14, $15)
     RETURNING capture_id, tenant_id::text, encounter_id::text,
               capturer_persona_id::text, device_uuid, device_attestation_id,
               raw_blob_id, captured_at, lat::text, lng::text, altitude::text,
               imu_signature, consent_ref, retention_class,
               retention_expires_at, status`,
    [
      captureId,
      input.tenant_id,
      input.encounter_id,
      input.capturer_persona_id,
      input.device_uuid,
      input.device_attestation_id,
      input.raw_blob_id,
      new Date(input.captured_at),
      input.lat ?? null,
      input.lng ?? null,
      input.altitude ?? null,
      imu,
      input.consent_ref,
      input.retention_class ?? DEFAULT_RETENTION_CLASS,
      input.retention_expires_at ? new Date(input.retention_expires_at) : null,
    ],
  );
  if (!row) throw new Error('[sdk-evidence] capture insert failed');

  // 3. Emit audit entry — must succeed because chain_of_custody.audit_entry_id
  //    is NOT NULL. Errors here propagate (caller's responsibility to retry).
  const auditEntry = await appendAuditEntry({
    pool_index: EVIDENCE_AUDIT_POOL,
    event_type: 'evidence.captured.v1',
    actor_kind: 'service',
    actor_id: 'sdk-evidence',
    tenant_id: input.tenant_id,
    subject_kind: 'evidence.capture',
    subject_id: captureId,
    retention_class: 'regulated',
    payload: {
      capture_id: captureId,
      encounter_id: input.encounter_id,
      capturer_persona_id: input.capturer_persona_id,
      device_uuid: input.device_uuid,
      raw_blob_id: input.raw_blob_id,
      blob_checksum_hex: checksum.toString('hex'),
      lat: input.lat ?? null,
      lng: input.lng ?? null,
      captured_at: input.captured_at,
    },
  });

  // 4. Append first chain-of-custody entry (seq=0, action='captured').
  //    audit_entry_id wires the two chains so a regulator can cross-verify.
  const chainEntry = await appendChainEntry({
    capture_id: captureId,
    action: 'captured',
    actor_persona_id: input.capturer_persona_id,
    blob_checksum: checksum,
    audit_entry_id: auditEntry.entry_id,
  });

  return {
    capture: rowToRef(row),
    chain_entry_id: chainEntry.entry_id,
    chain_seq: chainEntry.seq,
  };
}

export async function getCapture(capture_id: string): Promise<EvidenceCaptureRef | null> {
  const row = await dataService.one<CaptureRow>(
    `SELECT capture_id, tenant_id::text, encounter_id::text,
            capturer_persona_id::text, device_uuid, device_attestation_id,
            raw_blob_id, captured_at, lat::text, lng::text, altitude::text,
            imu_signature, consent_ref, retention_class,
            retention_expires_at, status
       FROM evidence.capture WHERE capture_id = $1`,
    [capture_id],
  );
  return row ? rowToRef(row) : null;
}

export async function listCapturesForEncounter(encounter_id: string): Promise<EvidenceCaptureRef[]> {
  const rows = await dataService.rows<CaptureRow>(
    `SELECT capture_id, tenant_id::text, encounter_id::text,
            capturer_persona_id::text, device_uuid, device_attestation_id,
            raw_blob_id, captured_at, lat::text, lng::text, altitude::text,
            imu_signature, consent_ref, retention_class,
            retention_expires_at, status
       FROM evidence.capture
      WHERE encounter_id = $1::uuid
      ORDER BY captured_at DESC`,
    [encounter_id],
  );
  return rows.map(rowToRef);
}
