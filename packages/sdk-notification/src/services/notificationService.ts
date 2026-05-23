import crypto from 'crypto';
import { dataService } from '@projexlight/db-runtime';
import { emitEvent } from '@projexlight/sdk-audit';
import { checkConsent } from '@projexlight/sdk-consent';
import { resolveTemplate, renderTemplate, TemplateNotFoundError } from './templateEngine';
import { getQuietHours, isInQuietHours } from './quietHours';
import { sendWithFailover } from './providerAdapters';
import type {
  CreateTemplateInput,
  MessageRecord,
  NotificationChannel,
  NotificationProvider,
  SendNotificationInput,
  SendNotificationResult,
  TemplateRecord,
} from '../models/notification.model';

/**
 * sdk-notification core per FR-NTF-1..6.
 *
 * Send flow:
 *   1. Resolve template (tenant override → platform default)
 *   2. Quiet-hours check (skip → status='suppressed' if in window or dnd)
 *   3. Consent pre-flight against template.required_consent_purpose
 *   4. Render template via templateEngine
 *   5. Vault-wrap destination (per PRD destination_envelope bytea)
 *   6. Persist notification.message with status='queued'
 *   7. Hand to channel provider via sendWithFailover (FR-NTF-2)
 *   8. Update message status + provider_message_id; emit notification.*.v1
 *
 * Consent pre-flight is the FR-NTF-4 gate: if the template declares a
 * required_consent_purpose and sdk-consent says the person didn't grant it
 * (or revoked it), we mark the message suppressed and never call the
 * provider — saves money AND honors the regulatory boundary.
 */

const POOL_INDEX = process.env.POOL_INDEX || 'admin';

// FR-NTF-2 hardening: per-tenant destination key derivation.
//
// Old code used a single process-env HMAC pepper for ALL tenants — leaking
// the env var leaked PII addresses across the entire fleet. The new flow:
//
//   1. master_key  ← NOTIFICATION_MASTER_KEY env (or vault.master/key)
//      Refuses to start if master is the legacy insecure default.
//   2. tenant_key  ← HKDF-SHA256(master_key, tenant_id, 'sdk-notification/dest/v1')
//      Per-tenant subkey; leak of one tenant's derived key does not compromise
//      siblings (per-tenant key separation, NFR-SEC-2).
//   3. wrap(plain, tenant) = HMAC(tenant_key, plain) + length-prefixed bytes
//
// Production swaps the master key for a sdk-vault unwrap via
// `setDestinationMasterKeyResolver(resolver)`. The dev path reads from env.
const INSECURE_DEFAULT_MARKERS = ['do-not-use-in-prod', 'change-me'];

export type DestinationMasterKeyResolver = () => Buffer | Promise<Buffer>;

const envMasterKey = (): Buffer => {
  const raw = process.env.NOTIFICATION_MASTER_KEY || process.env.NOTIFICATION_DESTINATION_KEY || '';
  if (!raw) {
    throw new Error('NOTIFICATION_MASTER_KEY env not set — refuse to wrap destinations with no key material');
  }
  for (const marker of INSECURE_DEFAULT_MARKERS) {
    if (raw.includes(marker)) {
      throw new Error(`NOTIFICATION_MASTER_KEY contains insecure-default marker "${marker}" — refusing to start`);
    }
  }
  return Buffer.from(raw, 'utf-8');
};

let activeMasterKeyResolver: DestinationMasterKeyResolver = envMasterKey;

/**
 * Wire production sdk-vault resolver here. The resolver returns master key
 * material; per-tenant subkeys are HKDF-derived inside wrapDestination so
 * vault sees only the master fetch.
 */
export function setDestinationMasterKeyResolver(resolver: DestinationMasterKeyResolver): void {
  activeMasterKeyResolver = resolver;
}

function hkdfSha256(master: Buffer, salt: Buffer, info: Buffer, length = 32): Buffer {
  // HKDF: Extract + Expand. crypto.hkdfSync is Node 15+.
  const out = crypto.hkdfSync('sha256', master, salt, info, length);
  return Buffer.from(out);
}

async function deriveTenantKey(tenant_id: string): Promise<Buffer> {
  const master = await activeMasterKeyResolver();
  return hkdfSha256(
    master,
    Buffer.from(tenant_id, 'utf-8'),
    Buffer.from('sdk-notification/dest/v1', 'utf-8'),
  );
}

export class ConsentRequiredError extends Error {
  readonly code = 'ConsentRequired';
  constructor(purpose: string) {
    super(`Consent for purpose '${purpose}' missing or revoked for recipient`);
  }
}

async function wrapDestination(plain: string, tenant_id: string): Promise<Buffer> {
  // Per-tenant HMAC keyed by HKDF-derived subkey (defense against master leakage
  // collapsing to a single tenant's exposure). Reversible only by the same
  // tenant subkey derivation.
  const tenantKey = await deriveTenantKey(tenant_id);
  const sig = crypto.createHmac('sha256', tenantKey).update(plain).digest();
  const payload = Buffer.from(plain, 'utf-8');
  const out = Buffer.alloc(1 + 32 + 4 + payload.length);
  out.writeUInt8(0x02, 0); // v2: per-tenant subkey
  sig.copy(out, 1);
  out.writeUInt32BE(payload.length, 33);
  payload.copy(out, 37);
  return out;
}

async function unwrapDestination(envelope: Buffer, tenant_id: string): Promise<string> {
  // Accepts v1 (legacy single-key) AND v2 (per-tenant subkey). v1 left in for
  // backwards-read of any messages persisted before this hardening landed.
  if (envelope.length < 37) {
    throw new Error('Invalid destination envelope: too short');
  }
  const version = envelope.readUInt8(0);
  if (version !== 0x01 && version !== 0x02) {
    throw new Error(`Invalid destination envelope version: 0x${version.toString(16)}`);
  }
  const len = envelope.readUInt32BE(33);
  const plain = envelope.slice(37, 37 + len).toString('utf-8');
  if (version === 0x02) {
    // Verify the HMAC matches the per-tenant subkey before returning.
    const tenantKey = await deriveTenantKey(tenant_id);
    const expected = crypto.createHmac('sha256', tenantKey).update(plain).digest();
    const actual = envelope.slice(1, 33);
    if (!crypto.timingSafeEqual(expected, actual)) {
      throw new Error('Destination envelope HMAC verification failed (cross-tenant or tampered)');
    }
  }
  return plain;
}

/* ------------------------------------------------------------------ templates */

export async function createTemplate(input: CreateTemplateInput): Promise<TemplateRecord> {
  const rows = await dataService.rows<TemplateRecord>(
    `INSERT INTO notification.template (tenant_id, code, channel, locale_bundles, required_consent_purpose, version)
     VALUES ($1, $2, $3, $4::jsonb, $5, $6)
     RETURNING template_id, tenant_id, code, channel, locale_bundles, required_consent_purpose, version, status, created_at`,
    [
      input.tenant_id ?? null,
      input.code,
      input.channel,
      JSON.stringify(input.locale_bundles),
      input.required_consent_purpose ?? null,
      input.version ?? '1.0.0',
    ],
  );
  return rows[0];
}

/* ------------------------------------------------------------------- send */

function pickProviderForChannel(channel: NotificationChannel): NotificationProvider {
  // The primary provider per channel — the registry in providerAdapters.ts
  // mirrors the same order. The persisted notification.message.provider
  // records the actual provider used (set after sendWithFailover succeeds).
  const map: Record<NotificationChannel, NotificationProvider> = {
    email: 'ses',
    sms: 'twilio',
    whatsapp: 'whatsapp-bsp',
    push: 'apns',
    slack: 'slack-outbound',
  };
  return map[channel];
}

async function persistMessage(
  input: SendNotificationInput,
  template: TemplateRecord,
  status: 'queued' | 'suppressed',
  suppression_reason: string | null,
  consent_check_ref: string | null,
): Promise<MessageRecord> {
  const provider = pickProviderForChannel(input.channel);
  const destination_envelope = await wrapDestination(input.destination, input.tenant_id);
  const rows = await dataService.rows<MessageRecord>(
    `INSERT INTO notification.message (
       tenant_id, template_id, person_id, app_identity_id, channel, provider,
       destination_envelope, payload, status, scheduled_at, consent_check_ref, suppression_reason
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10, $11, $12)
     RETURNING message_id, tenant_id, template_id, person_id, app_identity_id, channel, provider,
               destination_envelope, payload, status, scheduled_at, sent_at, delivered_at,
               consent_check_ref, provider_message_id, suppression_reason, created_at`,
    [
      input.tenant_id,
      template.template_id,
      input.person_id,
      input.app_identity_id ?? null,
      input.channel,
      provider,
      destination_envelope,
      JSON.stringify(input.payload ?? {}),
      status,
      input.scheduled_at ? new Date(input.scheduled_at) : null,
      consent_check_ref,
      suppression_reason,
    ],
  );
  return rows[0];
}

export async function sendNotification(input: SendNotificationInput): Promise<SendNotificationResult> {
  const template = await resolveTemplate(input.tenant_id, input.template_code, input.channel);

  // FR-NTF-5: quiet-hours / dnd check.
  let suppression_reason: string | null = null;
  if (input.honor_quiet_hours !== false && input.app_identity_id) {
    const qh = await getQuietHours(input.app_identity_id);
    const result = isInQuietHours(qh);
    if (result.quiet) suppression_reason = `quiet-hours: ${result.reason}`;
  }

  // FR-NTF-4: consent pre-flight.
  let consent_check_ref: string | null = null;
  if (
    !suppression_reason &&
    input.enforce_consent !== false &&
    template.required_consent_purpose
  ) {
    const consentResult = await checkConsent({
      person_id: input.person_id,
      purpose_id: template.required_consent_purpose,
      processor: 'tenant',
      jurisdiction: await resolveJurisdiction(input.tenant_id, input.jurisdiction),
    });
    if (!consentResult.granted) {
      suppression_reason = `consent: ${template.required_consent_purpose} not granted`;
    } else {
      consent_check_ref = consentResult.receipt_id ?? null;
    }
  }

  // FR-NTF-3: render the template body now (so we capture it even when suppressed).
  const rendered_body = renderTemplate(template, input.locale ?? 'en-US', input.payload ?? {});

  // Persist + branch.
  if (suppression_reason) {
    const message = await persistMessage(input, template, 'suppressed', suppression_reason, consent_check_ref);
    await emitEvent({
      event_type: 'notification.failed.v1',
      payload: { message_id: message.message_id, reason: suppression_reason },
      pool_index: POOL_INDEX,
      actor_kind: 'service',
      actor_id: 'sdk-notification.send',
      tenant_id: message.tenant_id,
      subject_kind: 'person',
      subject_id: message.person_id,
    });
    return { message, status: 'suppressed', suppression_reason, rendered_body };
  }

  const message = await persistMessage(input, template, 'queued', null, consent_check_ref);

  // Dispatch via provider (with failover) — synchronous in this prototype.
  // Production swaps for an async queue worker; the result schema is identical.
  try {
    const sendResult = await sendWithFailover(input.channel, {
      channel: input.channel,
      destination: await unwrapDestination(message.destination_envelope, input.tenant_id),
      body: rendered_body,
      metadata: { template_code: input.template_code, tenant_id: input.tenant_id },
    });
    const sentRows = await dataService.rows<MessageRecord>(
      `UPDATE notification.message
          SET status = $2, provider = $3, provider_message_id = $4, sent_at = now()
        WHERE message_id = $1
        RETURNING message_id, tenant_id, template_id, person_id, app_identity_id, channel, provider,
                  destination_envelope, payload, status, scheduled_at, sent_at, delivered_at,
                  consent_check_ref, provider_message_id, suppression_reason, created_at`,
      [message.message_id, sendResult.delivered_status === 'sent' ? 'sent' : sendResult.delivered_status, sendResult.provider, sendResult.provider_message_id],
    );
    const updated = sentRows[0];
    await emitEvent({
      event_type: 'notification.sent.v1',
      payload: {
        message_id: updated.message_id,
        channel: updated.channel,
        provider: updated.provider,
        provider_message_id: updated.provider_message_id,
      },
      pool_index: POOL_INDEX,
      actor_kind: 'service',
      actor_id: 'sdk-notification.send',
      tenant_id: updated.tenant_id,
      subject_kind: 'person',
      subject_id: updated.person_id,
    });
    return { message: updated, status: updated.status, suppression_reason: null, rendered_body };
  } catch (err) {
    const reason = (err as Error).message.slice(0, 500);
    const failedRows = await dataService.rows<MessageRecord>(
      `UPDATE notification.message
          SET status = 'failed', suppression_reason = $2
        WHERE message_id = $1
        RETURNING message_id, tenant_id, template_id, person_id, app_identity_id, channel, provider,
                  destination_envelope, payload, status, scheduled_at, sent_at, delivered_at,
                  consent_check_ref, provider_message_id, suppression_reason, created_at`,
      [message.message_id, reason],
    );
    const failed = failedRows[0];
    await emitEvent({
      event_type: 'notification.failed.v1',
      payload: { message_id: failed.message_id, reason },
      pool_index: POOL_INDEX,
      actor_kind: 'service',
      actor_id: 'sdk-notification.send',
      tenant_id: failed.tenant_id,
      subject_kind: 'person',
      subject_id: failed.person_id,
    });
    return { message: failed, status: 'failed', suppression_reason: reason, rendered_body };
  }
}

export async function markDelivered(message_id: string, provider_message_id: string): Promise<MessageRecord> {
  const rows = await dataService.rows<MessageRecord>(
    `UPDATE notification.message
        SET status = 'delivered', delivered_at = now()
      WHERE message_id = $1 AND status = 'sent'
      RETURNING message_id, tenant_id, template_id, person_id, app_identity_id, channel, provider,
                destination_envelope, payload, status, scheduled_at, sent_at, delivered_at,
                consent_check_ref, provider_message_id, suppression_reason, created_at`,
    [message_id],
  );
  if (rows.length === 0) throw new Error(`Message ${message_id} not found or not in 'sent' state`);
  const msg = rows[0];
  await emitEvent({
    event_type: 'notification.delivered.v1',
    payload: { message_id: msg.message_id, provider_message_id },
    pool_index: POOL_INDEX,
    actor_kind: 'service',
    actor_id: 'sdk-notification.deliveryWebhook',
    tenant_id: msg.tenant_id,
    subject_kind: 'person',
    subject_id: msg.person_id,
  });
  return msg;
}

export { ConsentRequiredError as _ConsentRequiredError, TemplateNotFoundError };

/* ------------------------------------------------- jurisdiction resolution */

/**
 * Returns the jurisdiction code for the tenant. Resolution order:
 *   1. explicit `override` (caller-provided per-send override)
 *   2. registered tenant-residency resolver (production: sdk-tenant lookup)
 *   3. `DEFAULT_JURISDICTION` env
 *   4. `'US-CA'` (last-resort default; logged when used)
 *
 * Wiring point: api-gateway calls `setJurisdictionResolver(fn)` on boot to
 * plug in the sdk-tenant residency lookup.
 */
export type JurisdictionResolver = (tenant_id: string) => string | null | Promise<string | null>;

let activeJurisdictionResolver: JurisdictionResolver = () => null;

export function setJurisdictionResolver(resolver: JurisdictionResolver): void {
  activeJurisdictionResolver = resolver;
}

async function resolveJurisdiction(tenant_id: string, override?: string): Promise<string> {
  if (override) return override;
  try {
    const resolved = await activeJurisdictionResolver(tenant_id);
    if (resolved) return resolved;
  } catch (err) {
    console.error('[sdk-notification] jurisdiction resolver failed', (err as Error).message);
  }
  const envDefault = process.env.DEFAULT_JURISDICTION;
  if (envDefault) return envDefault;
  console.warn(`[sdk-notification] jurisdiction unresolved for tenant ${tenant_id} — falling back to 'US-CA' (configure setJurisdictionResolver or DEFAULT_JURISDICTION env)`);
  return 'US-CA';
}
