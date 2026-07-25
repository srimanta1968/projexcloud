import { createCipheriv, createDecipheriv, randomBytes } from 'crypto';
import { dataService } from '@projexlight/db-runtime';
import { appendAuditEntry } from '@projexlight/sdk-audit';
import { setConfig, revokeConfig } from '@projexlight/sdk-config';
import { buildSmtpTransport, sendViaSmtp, type SmtpConfig } from './smtpEmailAdapter';
import type { SendArgs, SendResult } from './providerAdapters';

/**
 * Mirror an email-provider binding into the unified config plane (EP-341) so
 * sdk-config is the single registry of which notification provider a tenant has
 * configured. NON-SECRET marker only (kind + last_4 + binding_id) — the secret
 * envelope stays in notification.tenant_provider_credential and the live send
 * path is UNCHANGED. Drives resolveConfig('notification.email.credential', ctx)
 * for the 503 PROVIDER_NOT_CONFIGURED behaviour. Best-effort (never blocks).
 */
async function mirrorEmailProviderToConfig(
  binding: { binding_id: string; tenant_id: string; kind: string; status: string; last_4: string },
  actor_id: string,
): Promise<void> {
  const key = 'notification.email.credential';
  try {
    if (binding.status === 'revoked') {
      await revokeConfig('tenant', binding.tenant_id, key, actor_id);
    } else {
      await setConfig({
        scope: 'tenant',
        scope_id: binding.tenant_id,
        key,
        value: { configured: true, kind: binding.kind, last_4: binding.last_4, binding_id: binding.binding_id },
        set_by: actor_id,
      });
    }
  } catch {
    // Mirror is best-effort — the authoritative store is the credential table.
  }
}

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

/** Reverses wrapEnvelope: base64(iv).base64(tag).base64(ciphertext) -> plaintext secret. */
function unwrapEnvelope(envelope: Buffer): string {
  const [ivB64, tagB64, ctB64] = envelope.toString('utf8').split('.');
  if (!ivB64 || !tagB64 || !ctB64) throw new Error('malformed email provider credential envelope');
  const decipher = createDecipheriv('aes-256-gcm', wrapKey(), Buffer.from(ivB64, 'base64'));
  decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(ctB64, 'base64')), decipher.final()]).toString('utf8');
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

  await mirrorEmailProviderToConfig(inserted, input.actor_id);
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

  await mirrorEmailProviderToConfig(binding, input.actor_id);
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

  await mirrorEmailProviderToConfig(binding, input.actor_id);
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

// ─────────────────────────────────────────────────────────────────────
// Send resolution (tenant-first, platform-fallback) + verify + platform CRUD.
// ─────────────────────────────────────────────────────────────────────

interface ResolvedEmailProvider {
  kind: EmailProviderKind;
  config: Record<string, unknown>;
  from_address: string | null;
  credential: string;
}

/** Dispatches a send through a decrypted provider config (SMTP via nodemailer, SendGrid via HTTP). */
async function sendViaConfig(p: ResolvedEmailProvider, args: SendArgs): Promise<SendResult> {
  const from = p.from_address || process.env.FROM_EMAIL || process.env.NOTIFICATION_FROM_EMAIL;
  if (!from) throw new Error('email provider config missing from_address');
  if (p.kind === 'smtp') {
    const c = p.config as { host?: string; port?: number; secure?: boolean; user?: string; from_name?: string };
    if (!c.host) throw new Error('smtp config missing host');
    const cfg: SmtpConfig = {
      host: c.host,
      port: c.port ?? 587,
      secure: c.secure ?? false,
      user: c.user,
      pass: p.credential,
      from,
      fromName: c.from_name,
    };
    return sendViaSmtp(buildSmtpTransport(cfg), cfg, args);
  }
  if (p.kind === 'sendgrid') {
    const fromName = (p.config as { from_name?: string }).from_name;
    const res = await fetch('https://api.sendgrid.com/v3/mail/send', {
      method: 'POST',
      headers: { Authorization: `Bearer ${p.credential}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        personalizations: [{ to: [{ email: args.destination }] }],
        from: { email: from, name: fromName },
        subject: args.subject ?? 'Notification',
        content: [{ type: 'text/plain', value: args.body }],
      }),
    });
    if (!res.ok) throw new Error(`sendgrid ${res.status}: ${(await res.text()).slice(0, 200)}`);
    return {
      provider: 'sendgrid',
      provider_message_id: res.headers.get('x-message-id') ?? `sg_${Date.now().toString(36)}`,
      delivered_status: 'sent',
    };
  }
  // 'ses' per-tenant is not wired here; caller falls back to the env SES adapter.
  throw new Error(`per-provider send not supported for kind: ${p.kind}`);
}

/**
 * Send a PLATFORM (system) email — e.g. registration verification — using env-configured
 * credentials, independent of any per-tenant provider. Prefers SendGrid (SENDGRID_API_KEY),
 * falls back to SMTP (SMTP_HOST/…). Returns null when no platform sender is configured, so
 * callers can degrade gracefully (e.g. log the link in dev).
 */
export async function sendPlatformEmail(args: Omit<SendArgs, 'channel'>): Promise<SendResult | null> {
  const sendArgs: SendArgs = { channel: 'email', ...args };
  const sgKey = process.env.SENDGRID_API_KEY;
  if (sgKey) {
    return sendViaConfig({
      kind: 'sendgrid',
      config: { from_name: process.env.SENDGRID_FROM_NAME || process.env.FROM_NAME || 'ProjexCloud' },
      from_address: process.env.SENDGRID_FROM_EMAIL || process.env.FROM_EMAIL || null,
      credential: sgKey,
    }, sendArgs);
  }
  const host = process.env.SMTP_HOST;
  if (host) {
    return sendViaConfig({
      kind: 'smtp',
      config: {
        host,
        port: process.env.SMTP_PORT ? Number(process.env.SMTP_PORT) : 587,
        secure: process.env.SMTP_SECURE === 'true',
        user: process.env.SMTP_USER,
        from_name: process.env.FROM_NAME || 'ProjexCloud',
      },
      from_address: process.env.FROM_EMAIL || process.env.SMTP_USER || null,
      credential: process.env.SMTP_PASSWORD || '',
    }, sendArgs);
  }
  return null;
}

async function loadResolved(sql: string, params: unknown[]): Promise<ResolvedEmailProvider | null> {
  const row = await dataService.one<{
    kind: EmailProviderKind;
    config: Record<string, unknown> | null;
    from_address: string | null;
    credential_envelope: Buffer | null;
  }>(sql, params);
  if (!row || !row.credential_envelope) return null;
  return {
    kind: row.kind,
    config: row.config ?? {},
    from_address: row.from_address,
    credential: unwrapEnvelope(row.credential_envelope),
  };
}

/**
 * Tenant-first / platform-fallback email send. Returns the SendResult when a
 * tenant or platform provider is configured; returns null when neither exists so
 * the caller can fall through to the env-registered adapter (sendWithFailover).
 */
export async function resolveEmailSend(tenant_id: string, args: SendArgs): Promise<SendResult | null> {
  const tenant = await loadResolved(
    `SELECT kind, config, from_address, credential_envelope
       FROM notification.tenant_provider_credential
      WHERE tenant_id = $1::uuid AND channel = 'email' AND status = 'active' LIMIT 1`,
    [tenant_id],
  );
  if (tenant) return sendViaConfig(tenant, args);
  const platform = await loadResolved(
    `SELECT kind, config, from_address, credential_envelope
       FROM notification.provider
      WHERE channel = 'email' AND status = 'active' ORDER BY created_at DESC LIMIT 1`,
    [],
  );
  if (platform) return sendViaConfig(platform, args);
  return null;
}

/** Sends a real test email through a specific tenant provider to validate its config. */
export async function verifyEmailProvider(input: {
  tenant_id: string;
  binding_id: string;
  to: string;
}): Promise<SendResult> {
  const resolved = await loadResolved(
    `SELECT kind, config, from_address, credential_envelope
       FROM notification.tenant_provider_credential
      WHERE binding_id = $1 AND tenant_id = $2::uuid AND status = 'active' LIMIT 1`,
    [input.binding_id, input.tenant_id],
  );
  if (!resolved) throw new Error(`active email provider not found: ${input.binding_id}`);
  return sendViaConfig(resolved, {
    channel: 'email',
    destination: input.to,
    subject: 'ProjexCloud email provider test',
    body: 'This is a test message confirming your email provider configuration works.',
  });
}

export interface PlatformEmailProvider {
  provider_id: string;
  kind: EmailProviderKind;
  config: Record<string, unknown>;
  from_address: string | null;
  last_4: string | null;
  status: string;
  created_at?: string;
}

/** Platform-operator: set/replace the platform-default email provider (one active per channel). */
export async function setPlatformEmailProvider(input: {
  kind: EmailProviderKind;
  config?: Record<string, unknown>;
  from_address?: string;
  credential?: string;
  created_by?: string;
}): Promise<PlatformEmailProvider> {
  assertKind(input.kind);
  const envelope = input.credential ? wrapEnvelope(input.credential) : null;
  const last4 = input.credential && input.credential.length >= 4 ? input.credential.slice(-4) : null;
  return dataService.tx<PlatformEmailProvider>(async (q) => {
    await q(`UPDATE notification.provider SET status='revoked', updated_at=now() WHERE channel='email' AND status='active'`);
    const r = await q<PlatformEmailProvider>(
      `INSERT INTO notification.provider (channel, kind, config, from_address, credential_envelope, last_4, status, created_by)
       VALUES ('email', $1, $2::jsonb, $3, $4, $5, 'active', $6)
       RETURNING provider_id, kind, config, from_address, last_4, status`,
      [input.kind, JSON.stringify(input.config ?? {}), input.from_address ?? null, envelope, last4, input.created_by ?? null],
    );
    return r.rows[0];
  });
}

/** Platform-operator: read the active platform-default email provider (no secret). */
export async function getPlatformEmailProvider(): Promise<PlatformEmailProvider | null> {
  return dataService.one<PlatformEmailProvider>(
    `SELECT provider_id, kind, config, from_address, last_4, status, created_at
       FROM notification.provider
      WHERE channel = 'email' AND status = 'active' ORDER BY created_at DESC LIMIT 1`,
  );
}
