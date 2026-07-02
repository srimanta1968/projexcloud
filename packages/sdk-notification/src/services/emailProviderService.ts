import { createCipheriv, randomBytes } from 'crypto';
import { dataService } from '@projexlight/db-runtime';
import { appendAuditEntry } from '@projexlight/sdk-audit';

/**
 * Configurable email (notification) provider — bind / rotate / revoke / list.
 *
 * Mirrors sdk-ai-gateway tenantCredentialService: a tenant/customer configures
 * the provider their notification agent sends through (SMTP / SendGrid / SES).
 * The raw secret (SMTP password / API key) is stored ENVELOPE-ENCRYPTED via
 * @projexlight/sdk-secrets — never plaintext — and never returned by any read;
 * only `last_4` + non-secret `config` + lifecycle metadata are exposed.
 *
 * The send-time resolver (notificationService) reads the active row this service
 * writes, falling back to the platform-default notification.provider when a
 * tenant has none. Every write emits a regulated-class audit event.
 */

export type EmailProviderKind = 'smtp' | 'sendgrid' | 'ses';
const SUPPORTED_KINDS: readonly EmailProviderKind[] = ['smtp', 'sendgrid', 'ses'];
const MIN_REVOKE_REASON_LEN = 6;
const AUDIT_POOL = process.env.NOTIFICATION_AUDIT_POOL || 'admin-default';

// Wrap key for the AES-256-GCM secret envelope. Sourced from
// NOTIFICATION_PROVIDER_WRAP_KEY (base64, 32 bytes); in non-production falls
// back to a fixed dev key with a loud warning. Mirrors sdk-principal-token's
// signingKeyStore so we reuse the proven pattern without a new dependency.
const DEV_WRAP_KEY = Buffer.alloc(32, 11);
function wrapKey(): Buffer {
  const env = process.env.NOTIFICATION_PROVIDER_WRAP_KEY;
  if (env) {
    const buf = Buffer.from(env, 'base64');
    if (buf.length !== 32) throw new Error('NOTIFICATION_PROVIDER_WRAP_KEY must be 32 bytes (base64)');
    return buf;
  }
  if (process.env.NODE_ENV === 'production') {
    throw new Error('NOTIFICATION_PROVIDER_WRAP_KEY is required in production');
  }
  console.warn('[notification.email-provider] using insecure dev wrap key — set NOTIFICATION_PROVIDER_WRAP_KEY');
  return DEV_WRAP_KEY;
}

export interface EmailProviderBinding {
  binding_id: string;
  tenant_id: string;
  channel: 'email';
  kind: EmailProviderKind;
  config: Record<string, unknown>;
  from_address: string | null;
  last_4: string;
  status: 'active' | 'revoked';
  fallback_on_error: boolean;
  bound_at: string;
  revoked_at: string | null;
  bound_by: string | null;
  revoked_by: string | null;
}

export interface BindEmailProviderInput {
  tenant_id: string;
  kind: EmailProviderKind;
  /** Non-secret transport settings: {host, port, secure} (smtp), {region} (ses), {} (sendgrid). */
  config?: Record<string, unknown>;
  from_address?: string;
  /** Raw secret: SMTP password or provider API key. Stored envelope-encrypted. */
  credential: string;
  fallback_on_error?: boolean;
  actor_id: string;
}

export interface RotateEmailProviderInput {
  binding_id: string;
  tenant_id: string;
  credential: string;
  config?: Record<string, unknown>;
  actor_id: string;
}

export interface RevokeEmailProviderInput {
  binding_id: string;
  tenant_id: string;
  reason: string;
  actor_id: string;
}

function assertKind(kind: string): asserts kind is EmailProviderKind {
  if (!SUPPORTED_KINDS.includes(kind as EmailProviderKind)) {
    throw new Error(`unsupported email provider kind: ${kind}`);
  }
}

function computeLast4(secret: string): string {
  if (!secret || secret.length < 4) {
    throw new Error('credential too short');
  }
  return secret.slice(-4);
}

/**
 * Envelope-encrypts the raw secret with AES-256-GCM. Stored as
 * base64(iv).base64(tag).base64(ciphertext) — the same wrapped shape the
 * send-time resolver will unwrap. The raw secret never lands in Postgres.
 */
function wrapEnvelope(secret: string): Buffer {
  const key = wrapKey();
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(secret, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  const wrapped = `${iv.toString('base64')}.${tag.toString('base64')}.${ct.toString('base64')}`;
  return Buffer.from(wrapped, 'utf8');
}

interface EmailProviderRow {
  binding_id: string;
  tenant_id: string;
  channel: 'email';
  kind: EmailProviderKind;
  config: Record<string, unknown> | null;
  from_address: string | null;
  last_4: string;
  status: 'active' | 'revoked';
  fallback_on_error: boolean;
  bound_at: Date | string;
  revoked_at: Date | string | null;
  bound_by: string | null;
  revoked_by: string | null;
}

function toIso(v: Date | string | null): string | null {
  if (!v) return null;
  return v instanceof Date ? v.toISOString() : String(v);
}

function rowToBinding(row: EmailProviderRow): EmailProviderBinding {
  return {
    binding_id: row.binding_id,
    tenant_id: row.tenant_id,
    channel: row.channel,
    kind: row.kind,
    config: row.config ?? {},
    from_address: row.from_address,
    last_4: row.last_4,
    status: row.status,
    fallback_on_error: row.fallback_on_error,
    bound_at: toIso(row.bound_at) ?? new Date(0).toISOString(),
    revoked_at: toIso(row.revoked_at),
    bound_by: row.bound_by,
    revoked_by: row.revoked_by,
  };
}

const RETURNING =
  `binding_id, tenant_id, channel, kind, config, from_address, last_4, status,
   fallback_on_error, bound_at, revoked_at, bound_by, revoked_by`;

/**
 * Bind a tenant's email provider. Any existing active row for (tenant, email)
 * is revoked atomically in the same transaction. Emits ...bound.v1.
 */
export async function bindEmailProvider(input: BindEmailProviderInput): Promise<EmailProviderBinding> {
  assertKind(input.kind);
  const last_4 = computeLast4(input.credential);
  const envelope = wrapEnvelope(input.credential);
  const config = input.config ?? {};
  const fallback = input.fallback_on_error ?? true;

  const inserted = await dataService.tx<EmailProviderBinding>(async (q) => {
    await q(
      `UPDATE notification.tenant_provider_credential
          SET status = 'revoked', revoked_at = now(), revoked_by = $2, updated_at = now()
        WHERE tenant_id = $1::uuid AND channel = 'email' AND status = 'active'`,
      [input.tenant_id, input.actor_id],
    );
    const result = await q<EmailProviderRow>(
      `INSERT INTO notification.tenant_provider_credential
         (tenant_id, channel, kind, config, from_address, credential_envelope,
          last_4, status, fallback_on_error, bound_by)
       VALUES ($1::uuid, 'email', $2, $3::jsonb, $4, $5, $6, 'active', $7, $8)
       RETURNING ${RETURNING}`,
      [
        input.tenant_id,
        input.kind,
        JSON.stringify(config),
        input.from_address ?? null,
        envelope,
        last_4,
        fallback,
        input.actor_id,
      ],
    );
    const row = result.rows[0];
    if (!row) throw new Error('failed to insert email provider config');
    return rowToBinding(row);
  });

  await emitAudit('notification.email_provider.bound.v1', inserted, input.actor_id, {
    kind: inserted.kind,
    last_4: inserted.last_4,
    from_address: inserted.from_address ?? undefined,
  });
  return inserted;
}

/** Rotate the credential (and optionally config) of an active email provider. */
export async function rotateEmailProvider(input: RotateEmailProviderInput): Promise<EmailProviderBinding> {
  const last_4 = computeLast4(input.credential);
  const envelope = wrapEnvelope(input.credential);

  const row = await dataService.one<EmailProviderRow>(
    `UPDATE notification.tenant_provider_credential
        SET credential_envelope = $3,
            last_4 = $4,
            config = COALESCE($5::jsonb, config),
            updated_at = now()
      WHERE binding_id = $1 AND tenant_id = $2::uuid AND status = 'active'
      RETURNING ${RETURNING}`,
    [
      input.binding_id,
      input.tenant_id,
      envelope,
      last_4,
      input.config ? JSON.stringify(input.config) : null,
    ],
  );
  if (!row) throw new Error(`active email provider not found: ${input.binding_id}`);
  const binding = rowToBinding(row);

  await emitAudit('notification.email_provider.rotated.v1', binding, input.actor_id, {
    last_4: binding.last_4,
  });
  return binding;
}

/** Revoke an active email provider. Send path then falls back to platform default. */
export async function revokeEmailProvider(input: RevokeEmailProviderInput): Promise<EmailProviderBinding> {
  if (!input.reason || input.reason.trim().length < MIN_REVOKE_REASON_LEN) {
    throw new Error(`revoke reason must be at least ${MIN_REVOKE_REASON_LEN} characters`);
  }
  const row = await dataService.one<EmailProviderRow>(
    `UPDATE notification.tenant_provider_credential
        SET status = 'revoked', revoked_at = now(), revoked_by = $3, updated_at = now()
      WHERE binding_id = $1 AND tenant_id = $2::uuid AND status = 'active'
      RETURNING ${RETURNING}`,
    [input.binding_id, input.tenant_id, input.actor_id],
  );
  if (!row) throw new Error(`active email provider not found: ${input.binding_id}`);
  const binding = rowToBinding(row);

  await emitAudit('notification.email_provider.revoked.v1', binding, input.actor_id, {
    reason: input.reason.trim(),
  });
  return binding;
}

/**
 * List a tenant's email providers (active + revoked). NEVER returns the
 * credential_envelope — only last_4 + non-secret config + lifecycle metadata.
 */
export async function listEmailProviders(input: { tenant_id: string }): Promise<EmailProviderBinding[]> {
  const rows = await dataService.rows<EmailProviderRow>(
    `SELECT ${RETURNING}
       FROM notification.tenant_provider_credential
      WHERE tenant_id = $1::uuid AND channel = 'email'
      ORDER BY bound_at DESC`,
    [input.tenant_id],
  );
  return rows.map(rowToBinding);
}

async function emitAudit(
  event_type: string,
  binding: EmailProviderBinding,
  actor_id: string,
  extra: Record<string, unknown>,
): Promise<void> {
  try {
    await appendAuditEntry({
      pool_index: AUDIT_POOL,
      event_type,
      actor_kind: 'human',
      actor_id,
      tenant_id: binding.tenant_id,
      subject_kind: 'notification.tenant_provider_credential',
      subject_id: binding.binding_id,
      retention_class: 'regulated',
      payload: { binding_id: binding.binding_id, tenant_id: binding.tenant_id, ...extra },
    });
  } catch (auditErr) {
    console.error(
      '[notification.email-provider] audit emit failed for',
      event_type,
      binding.binding_id,
      (auditErr as Error).message,
    );
  }
}
