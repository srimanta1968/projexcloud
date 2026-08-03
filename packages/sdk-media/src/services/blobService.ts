import crypto from 'crypto';
import { dataService } from '@projexlight/db-runtime';
import { emitEvent } from '@projexlight/sdk-audit';
import type {
  BlobRecord,
  IssuePlaybackUrlResult,
  IssueUploadUrlInput,
  IssueUploadUrlResult,
  SignedUrlRecord,
} from '../models/media.model';

/**
 * sdk-media blob lifecycle per FR-MED-1, FR-MED-2, FR-MED-4, FR-MED-5.
 *
 * Wraps S3 access behind signed URLs scoped per-tenant. Bytes never enter our
 * process — they go directly from client to S3 via the signed URL. Envelope
 * key is resolved per (tenant, encounter): if encounter_id is bound, we
 * select the encounter-tier key from vault.key; otherwise the per-tenant key.
 *
 * Sealed encounters block new evidence per FR-MED-5: the encounter check
 * happens here so the upload URL is never issued for a sealed encounter.
 *
 * The actual S3 signer is plug-replaceable: in dev/test we emit a synthetic
 * URL pointing at a local minio container; production swaps in the AWS S3
 * presigner via `MEDIA_S3_SIGNER=aws-s3`.
 */

const POOL_INDEX = process.env.POOL_INDEX || 'admin';
const S3_BUCKET = process.env.MEDIA_S3_BUCKET || 'projexcloud-media-dev';
const S3_REGION = process.env.AWS_REGION || 'us-east-1';
const MAX_UPLOAD_TTL_SECONDS = 3600;
const MAX_PLAYBACK_TTL_SECONDS = 86_400;

export class SealedEncounterError extends Error {
  readonly code = 'SealedEncounter';
  constructor(encounter_id: string) {
    super(`Encounter ${encounter_id} is sealed; new evidence blocked per FR-MED-5`);
  }
}

export class BlobNotFoundError extends Error {
  readonly code = 'BlobNotFound';
  constructor(blob_id: string) {
    super(`Blob ${blob_id} not found`);
  }
}

export class TenantOwnershipError extends Error {
  readonly code = 'TenantOwnership';
  constructor(message: string) { super(message); }
}

function assertTenantOwnership(resource_tenant_id: string, actor_tenant_id: string | undefined, op: string): void {
  if (!actor_tenant_id) throw new TenantOwnershipError(`${op}: actor_tenant_id required`);
  if (resource_tenant_id !== actor_tenant_id) {
    throw new TenantOwnershipError(`${op}: caller tenant ${actor_tenant_id} does not own this blob`);
  }
}

function buildS3Key(tenant_id: string, blob_id: string, content_type: string): string {
  const ext = content_type.split('/').pop()?.replace(/[^a-z0-9]/gi, '') || 'bin';
  return `tenants/${tenant_id}/${blob_id}.${ext}`;
}

/**
 * Pluggable S3 signer. The default in-process signer is synthetic — useful for
 * dev/test but the URLs it produces are NOT valid AWS Sig-V4 and will be
 * rejected by real S3. Production must call `registerS3Signer(awsSigV4Signer)`
 * at boot. We refuse to use the synthetic signer in production unless
 * ALLOW_SYNTHETIC_S3_SIGNER=true (sandbox tenants).
 */
export interface S3SignerArgs {
  method: 'GET' | 'PUT';
  bucket: string;
  key: string;
  ttl_seconds: number;
}
export type S3Signer = (args: S3SignerArgs) => string | Promise<string>;

const SYNTHETIC_ALLOWED = (): boolean => {
  if (process.env.NODE_ENV !== 'production') return true;
  return process.env.ALLOW_SYNTHETIC_S3_SIGNER === 'true';
};

const SYNTHETIC_SIGNER: S3Signer = (input) => {
  const expires = Math.floor(Date.now() / 1000) + input.ttl_seconds;
  const sig = crypto
    .createHash('sha256')
    .update(`${input.method}\n${input.bucket}\n${input.key}\n${expires}`)
    .digest('hex')
    .slice(0, 32);
  return `https://${input.bucket}.s3.${S3_REGION}.amazonaws.com/${input.key}?X-Method=${input.method}&X-Expires=${expires}&X-Signature=${sig}`;
};

const FAIL_LOUD_SIGNER: S3Signer = () => {
  throw new Error('sdk-media: no S3 signer registered for production — wire registerS3Signer(awsSigV4Signer) before boot, or set ALLOW_SYNTHETIC_S3_SIGNER=true for sandbox tenants');
};

let activeSigner: S3Signer = SYNTHETIC_ALLOWED() ? SYNTHETIC_SIGNER : FAIL_LOUD_SIGNER;

export function registerS3Signer(signer: S3Signer): void {
  activeSigner = signer;
}

async function signUrl(input: S3SignerArgs): Promise<string> {
  return activeSigner(input);
}

/**
 * Resolves the vault key reference for envelope encryption. The actual KEK
 * comes from vault.key; this function just resolves the right key_id for the
 * (tenant, encounter) tuple. sdk-vault handles the unwrap on read.
 */
async function resolveVaultKeyRef(tenant_id: string, encounter_id?: string): Promise<string> {
  if (encounter_id) {
    const enc = await dataService.one<{ key_id: string }>(
      `SELECT key_id FROM vault.key
        WHERE tier = 'encounter' AND scope_id = $1 AND state = 'active'
        LIMIT 1`,
      [encounter_id],
    );
    if (enc) return enc.key_id;
  }
  const tenantKey = await dataService.one<{ key_id: string }>(
    `SELECT key_id FROM vault.key
      WHERE tier = 'tenant' AND scope_id = $1 AND state = 'active'
      LIMIT 1`,
    [tenant_id],
  );
  if (!tenantKey) {
    throw new Error(`No active vault tenant key for tenant ${tenant_id}; provision via sdk-vault first`);
  }
  return tenantKey.key_id;
}

/**
 * Refuses to issue upload URLs for sealed encounters. Encounter sealing
 * is owned by sdk-vault (vault.encounter_key_seal) — a sealed encounter
 * has the seal row marking its key shredded.
 */
async function assertEncounterNotSealed(encounter_id: string): Promise<void> {
  const sealed = await dataService.one<{ sealed_at: Date }>(
    `SELECT sealed_at FROM vault.encounter_key_seal WHERE encounter_id = $1 LIMIT 1`,
    [encounter_id],
  );
  if (sealed) {
    throw new SealedEncounterError(encounter_id);
  }
}

/**
 * Issues a presigned upload URL + creates the blob metadata row. The client
 * uploads directly to S3 using the URL; on success they call
 * markBlobReady(blob_id) which flips status to 'ready'.
 */
export async function issueUploadUrl(input: IssueUploadUrlInput): Promise<IssueUploadUrlResult> {
  if (input.encounter_id) {
    await assertEncounterNotSealed(input.encounter_id);
  }
  const vault_key_ref = await resolveVaultKeyRef(input.tenant_id, input.encounter_id);
  const ttl_seconds = Math.min(input.ttl_seconds ?? 900, MAX_UPLOAD_TTL_SECONDS);

  // Insert blob row first so we can build a stable s3_key keyed by the
  // surrogate blob_id; the upload URL points at this fixed key.
  const blobRows = await dataService.rows<{ blob_id: string }>(
    `INSERT INTO media.blob (
       tenant_id, encounter_id, persona_id, s3_key, content_type, byte_size,
       vault_key_ref, checksum, status
     ) VALUES ($1, $2, $3, '', $4, $5, $6, ''::bytea, 'uploading')
     RETURNING blob_id`,
    [
      input.tenant_id,
      input.encounter_id ?? null,
      input.persona_id,
      input.content_type,
      input.byte_size,
      vault_key_ref,
    ],
  );
  const blob_id = blobRows[0].blob_id;
  const s3_key = buildS3Key(input.tenant_id, blob_id, input.content_type);
  await dataService.query(
    `UPDATE media.blob SET s3_key = $1 WHERE blob_id = $2`,
    [s3_key, blob_id],
  );

  const upload_url = await signUrl({ method: 'PUT', bucket: S3_BUCKET, key: s3_key, ttl_seconds });
  const expires_at = new Date(Date.now() + ttl_seconds * 1000);

  const urlRows = await dataService.rows<{ url_id: string }>(
    `INSERT INTO media.signed_url (blob_id, kind, persona_id, expires_at)
     VALUES ($1, 'upload', $2, $3)
     RETURNING url_id`,
    [blob_id, input.persona_id, expires_at],
  );

  return { blob_id, url_id: urlRows[0].url_id, upload_url, expires_at, s3_key };
}

/**
 * Issues a presigned playback URL. Refuses on shredded blobs.
 */
export async function issuePlaybackUrl(
  blob_id: string,
  persona_id: string,
  ttl_seconds = 600,
  actor_tenant_id?: string,
): Promise<IssuePlaybackUrlResult> {
  const blob = await dataService.one<BlobRecord>(
    `SELECT blob_id, tenant_id, encounter_id, persona_id, s3_key, content_type, byte_size,
            vault_key_ref, checksum, variants, uploaded_at, status
       FROM media.blob WHERE blob_id = $1`,
    [blob_id],
  );
  if (!blob) throw new BlobNotFoundError(blob_id);
  assertTenantOwnership(blob.tenant_id, actor_tenant_id, 'issuePlaybackUrl');
  if (blob.status === 'shredded') {
    throw new Error(`Blob ${blob_id} has been cryptographically shredded`);
  }
  const ttl = Math.min(ttl_seconds, MAX_PLAYBACK_TTL_SECONDS);
  const expires_at = new Date(Date.now() + ttl * 1000);
  const playback_url = await signUrl({ method: 'GET', bucket: S3_BUCKET, key: blob.s3_key, ttl_seconds: ttl });

  const rows = await dataService.rows<SignedUrlRecord>(
    `INSERT INTO media.signed_url (blob_id, kind, persona_id, expires_at)
     VALUES ($1, 'download', $2, $3)
     RETURNING url_id, blob_id, kind, persona_id, expires_at, issued_at`,
    [blob_id, persona_id, expires_at],
  );
  return { url_id: rows[0].url_id, playback_url, expires_at };
}

/**
 * Flips the blob from 'uploading' → 'ready' after the client confirms upload
 * success. Updates checksum from the client-reported SHA-256.
 *
 * Server-side verification (stream-the-object SHA-256 against the reported
 * value) is a separate async-lambda workstream. The defense here is two-layered:
 *   - format guard: checksum_hex must be 64 hex chars (SHA-256 length);
 *   - ownership guard: the blob's tenant_id must match actor_tenant_id, so a
 *     cross-tenant attacker who learns a blob_id cannot finalize it.
 * A malicious client can still report a fake checksum for THEIR OWN blob —
 * caught downstream by the verification lambda when implemented.
 */
export async function markBlobReady(
  blob_id: string,
  checksum_hex: string,
  actor_tenant_id?: string,
): Promise<BlobRecord> {
  const clean = checksum_hex.replace(/^0x/, '').toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(clean)) {
    throw new Error('checksum_hex must be 64-char hex (SHA-256)');
  }
  const checksum = Buffer.from(clean, 'hex');

  // Load + tenant check BEFORE flipping status, so a cross-tenant attacker
  // can't probe blob existence by status transitions.
  const existing = await dataService.one<{ tenant_id: string; status: string }>(
    `SELECT tenant_id, status FROM media.blob WHERE blob_id = $1`,
    [blob_id],
  );
  if (!existing) throw new BlobNotFoundError(blob_id);
  assertTenantOwnership(existing.tenant_id, actor_tenant_id, 'markBlobReady');

  const rows = await dataService.rows<BlobRecord>(
    `UPDATE media.blob
        SET status = 'ready', checksum = $2
      WHERE blob_id = $1 AND status = 'uploading'
      RETURNING blob_id, tenant_id, encounter_id, persona_id, s3_key, content_type,
                byte_size, vault_key_ref, checksum, variants, uploaded_at, status`,
    [blob_id, checksum],
  );
  if (rows.length === 0) {
    throw new BlobNotFoundError(blob_id);
  }
  const blob = rows[0];
  await emitEvent({
    event_type: 'media.blob.uploaded.v1',
    payload: {
      blob_id: blob.blob_id,
      tenant_id: blob.tenant_id,
      encounter_id: blob.encounter_id,
      content_type: blob.content_type,
      byte_size: blob.byte_size,
    },
    pool_index: POOL_INDEX,
    actor_kind: 'service',
    actor_id: 'sdk-media.markReady',
    tenant_id: blob.tenant_id,
    subject_kind: 'media.blob',
    subject_id: blob.blob_id,
  });
  return blob;
}

/**
 * Marks a blob shredded - composes with sdk-vault key shred chains. Once
 * shredded, the bytes in S3 remain but the wrapping key is destroyed so the
 * payload is permanently undecryptable.
 */
export async function shredBlob(blob_id: string): Promise<void> {
  const rows = await dataService.rows<{ tenant_id: string }>(
    `UPDATE media.blob SET status = 'shredded'
      WHERE blob_id = $1 AND status <> 'shredded'
      RETURNING tenant_id`,
    [blob_id],
  );
  if (rows.length === 0) return;
  await emitEvent({
    event_type: 'media.blob.shredded.v1',
    payload: { blob_id },
    pool_index: POOL_INDEX,
    actor_kind: 'service',
    actor_id: 'sdk-media.shred',
    tenant_id: rows[0].tenant_id,
    subject_kind: 'media.blob',
    subject_id: blob_id,
  });
}

export async function getBlob(blob_id: string): Promise<BlobRecord | null> {
  return dataService.one<BlobRecord>(
    `SELECT blob_id, tenant_id, encounter_id, persona_id, s3_key, content_type,
            byte_size, vault_key_ref, checksum, variants, uploaded_at, status
       FROM media.blob WHERE blob_id = $1`,
    [blob_id],
  );
}

/**
 * P5 HDK editor entry point. Appends one edit op to media.blob.edit_history
 * (the column added by 002_hdk_editor_columns.sql). hdk-image-editor and
 * hdk-video-editor call this from their TS facade after hdk-sync replays
 * a queued edit. event-sourcing conflict policy means the append is safe
 * regardless of device-reconnect order — final history is deterministic
 * by the op's `ts` field once we expose RGA-style ordering in P6.
 */
export async function appendEditOp(
  blob_id: string,
  op: Record<string, unknown>,
): Promise<{ blob_id: string; edit_history_len: number } | null> {
  const rows = await dataService.rows<{ blob_id: string; len: number }>(
    `UPDATE media.blob
        SET edit_history = edit_history || $2::jsonb
      WHERE blob_id = $1
      RETURNING blob_id, jsonb_array_length(edit_history) AS len`,
    [blob_id, JSON.stringify([op])],
  );
  if (rows.length === 0) return null;
  return { blob_id: rows[0].blob_id, edit_history_len: Number(rows[0].len) };
}
