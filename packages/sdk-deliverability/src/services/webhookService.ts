import { createHmac, timingSafeEqual } from 'crypto';
import { dataService } from '@projexlight/db-runtime';
import { suppress, hashAddress, type Channel } from './suppressionService';

/**
 * @projexlight/sdk-deliverability — provider bounce/complaint webhook processing (P14·E3, TK-3625).
 *
 * Verifies inbound provider webhooks (SendGrid / Mailgun / Postmark / SES / Twilio) by
 * per-tenant HMAC, classifies each event as hard_bounce / soft_bounce / complaint, and
 * AUTO-SUPPRESSES the recipient on a hard bounce or complaint (soft bounces are recorded
 * but not suppressed). Every processed event is audited in deliverability.bounce_event.
 */

export type Provider = 'ses' | 'sendgrid' | 'mailgun' | 'postmark' | 'twilio';
export type Classification = 'hard_bounce' | 'soft_bounce' | 'complaint' | 'delivered' | 'other';

export interface ClassifiedEvent {
  classification: Classification;
  address: string | null;
  message_id: string | null;
  event_type: string | null;
  channel: Channel;
}

/* --------------------------------------------------------------- signing secret */

export interface UpsertSecretInput {
  tenantId: string;
  provider: Provider;
  signingSecret: string;
  algo?: 'sha1' | 'sha256';
}

/** Register (or rotate) the HMAC signing secret for a tenant's provider webhook. */
export async function upsertWebhookSecret(input: UpsertSecretInput): Promise<{ secret_id: string; provider: string }> {
  const rows = await dataService.rows<{ secret_id: string; provider: string }>(
    `INSERT INTO deliverability.webhook_secret (tenant_id, provider, signing_secret, algo)
     VALUES ($1,$2,$3,COALESCE($4,'sha256'))
     ON CONFLICT (tenant_id, provider)
     DO UPDATE SET signing_secret = EXCLUDED.signing_secret, algo = EXCLUDED.algo, is_active = true, updated_at = now()
     RETURNING secret_id, provider`,
    [input.tenantId, input.provider, input.signingSecret, input.algo ?? null],
  );
  return rows[0];
}

/**
 * Verify a webhook signature. Returns { verified, enforced }: when no active secret is
 * configured for (tenant, provider) the webhook is accepted with enforced=false (dev /
 * not-yet-configured); when a secret IS configured the HMAC must match (timing-safe) or
 * verified=false. `signature` is the provider signature header value (hex or base64).
 */
export async function verifyWebhookSignature(
  tenantId: string, provider: Provider, rawBody: string, signature: string | undefined,
): Promise<{ verified: boolean; enforced: boolean }> {
  const secret = await dataService.one<{ signing_secret: string; algo: string }>(
    `SELECT signing_secret, algo FROM deliverability.webhook_secret
      WHERE tenant_id = $1 AND provider = $2 AND is_active LIMIT 1`,
    [tenantId, provider],
  );
  if (!secret) return { verified: true, enforced: false };
  if (!signature) return { verified: false, enforced: true };
  const digest = createHmac(secret.algo, secret.signing_secret).update(rawBody, 'utf8').digest();
  // Accept either hex or base64 signature encodings.
  const candidates = [Buffer.from(signature, 'hex'), Buffer.from(signature, 'base64')];
  const verified = candidates.some((c) => c.length === digest.length && timingSafeEqual(c, digest));
  return { verified, enforced: true };
}

/* --------------------------------------------------------------- classification */

const norm = (s: unknown): string => String(s ?? '').toLowerCase();

/**
 * Classify a provider payload into normalized events. Handles a normalized envelope
 * ({event_type, address}) plus SES-SNS, SendGrid (batch array), Mailgun and Postmark
 * shapes. Unknown shapes yield a single 'other' event so nothing is silently dropped.
 */
export function classifyEvents(provider: Provider, payload: unknown): ClassifiedEvent[] {
  const out: ClassifiedEvent[] = [];
  const pushEvent = (classification: Classification, address: unknown, message_id: unknown, event_type: unknown, channel: Channel = 'email') =>
    out.push({ classification, address: address ? String(address) : null, message_id: message_id ? String(message_id) : null, event_type: event_type ? String(event_type) : null, channel });

  // Normalized envelope (also what our own tests / internal producers send).
  const single = payload as Record<string, unknown>;
  if (single && (single.event_type || single.classification) && (single.address || single.email || single.recipient)) {
    const c = norm(single.classification || single.event_type);
    const cls: Classification = c.includes('complaint') || c.includes('spam') ? 'complaint'
      : c.includes('hard') || c === 'bounce' ? 'hard_bounce'
      : c.includes('soft') || c.includes('defer') || c.includes('transient') ? 'soft_bounce'
      : c.includes('deliver') ? 'delivered' : 'other';
    pushEvent(cls, single.address || single.email || single.recipient, single.message_id || single.messageId, single.event_type || single.classification,
      norm(single.channel) === 'sms' ? 'sms' : 'email');
    return out;
  }

  // SendGrid: array of event objects.
  if (Array.isArray(payload)) {
    for (const ev of payload as Array<Record<string, unknown>>) {
      const e = norm(ev.event);
      const cls: Classification = e === 'bounce' || e === 'dropped' ? 'hard_bounce'
        : e === 'deferred' ? 'soft_bounce'
        : e === 'spamreport' ? 'complaint'
        : e === 'delivered' ? 'delivered' : 'other';
      if (cls !== 'other') pushEvent(cls, ev.email, ev.sg_message_id || ev.smtp_id, ev.event);
    }
    if (out.length) return out;
  }

  // SES via SNS: { notificationType, bounce|complaint }.
  const nt = norm(single?.notificationType);
  if (nt === 'bounce' && single.bounce) {
    const b = single.bounce as Record<string, unknown>;
    const cls: Classification = norm(b.bounceType) === 'permanent' ? 'hard_bounce' : 'soft_bounce';
    for (const r of (b.bouncedRecipients as Array<Record<string, unknown>> | undefined) ?? [])
      pushEvent(cls, r.emailAddress, (single.mail as Record<string, unknown> | undefined)?.messageId, `ses.bounce.${norm(b.bounceType)}`);
    if (out.length) return out;
  }
  if (nt === 'complaint' && single.complaint) {
    const c = single.complaint as Record<string, unknown>;
    for (const r of (c.complainedRecipients as Array<Record<string, unknown>> | undefined) ?? [])
      pushEvent('complaint', r.emailAddress, (single.mail as Record<string, unknown> | undefined)?.messageId, 'ses.complaint');
    if (out.length) return out;
  }

  // Postmark: { RecordType: 'Bounce', Type, Email }.
  if (single && norm(single.RecordType) === 'bounce') {
    const t = norm(single.Type);
    const cls: Classification = t.includes('spam') || t.includes('complaint') ? 'complaint'
      : t.includes('soft') || t.includes('transient') ? 'soft_bounce' : 'hard_bounce';
    pushEvent(cls, single.Email, single.MessageID, `postmark.${t}`);
    return out;
  }

  // Mailgun: { 'event-data': { event, severity, recipient } } or flat.
  const md = (single?.['event-data'] as Record<string, unknown> | undefined) ?? single;
  if (md && (norm(md.event) === 'failed' || norm(md.event) === 'complained')) {
    const cls: Classification = norm(md.event) === 'complained' ? 'complaint'
      : norm(md.severity) === 'temporary' ? 'soft_bounce' : 'hard_bounce';
    pushEvent(cls, md.recipient, (md.message as Record<string, unknown> | undefined)?.headers && ((md.message as Record<string, unknown>).headers as Record<string, unknown>)['message-id'], `mailgun.${norm(md.event)}`);
    return out;
  }

  return out;
}

/* ------------------------------------------------------------------ processing */

export interface ProcessWebhookInput {
  tenantId: string;
  provider: Provider;
  payload: unknown;
  signatureVerified: boolean;
}
export interface ProcessWebhookResult {
  processed: number;
  suppressed: number;
  events: Array<{ classification: Classification; suppressed: boolean }>;
}

/**
 * Process a verified webhook: classify events, auto-suppress hard_bounce/complaint
 * recipients (reason mapped from the classification), and audit each in bounce_event.
 * Soft bounces and deliveries are recorded but not suppressed.
 */
export async function processBounceWebhook(input: ProcessWebhookInput): Promise<ProcessWebhookResult> {
  const events = classifyEvents(input.provider, input.payload);
  let suppressed = 0;
  const summary: Array<{ classification: Classification; suppressed: boolean }> = [];

  for (const ev of events) {
    let didSuppress = false;
    if (ev.address && (ev.classification === 'hard_bounce' || ev.classification === 'complaint')) {
      await suppress({
        tenantId: input.tenantId,
        channel: ev.channel,
        address: ev.address,
        reason: ev.classification === 'complaint' ? 'complaint' : 'hard_bounce',
        reasonDetail: ev.event_type ?? undefined,
        source: `webhook:${input.provider}`,
      });
      didSuppress = true;
      suppressed += 1;
    }
    await dataService.rows(
      `INSERT INTO deliverability.bounce_event
         (tenant_id, provider, event_type, classification, channel, address_hash, message_id, suppressed, signature_verified, raw)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb)`,
      [input.tenantId, input.provider, ev.event_type, ev.classification, ev.channel,
       ev.address ? hashAddress(ev.channel, ev.address) : null, ev.message_id, didSuppress,
       input.signatureVerified, JSON.stringify({ classification: ev.classification, event_type: ev.event_type })],
    );
    summary.push({ classification: ev.classification, suppressed: didSuppress });
  }
  return { processed: events.length, suppressed, events: summary };
}

export interface BounceEventRow {
  event_id: string;
  provider: string;
  event_type: string | null;
  classification: string;
  message_id: string | null;
  suppressed: boolean;
  received_at: string;
}

/** List a tenant's processed bounce/complaint events, newest first. */
export async function listBounceEvents(tenantId: string, opts: { classification?: string; limit?: number } = {}): Promise<BounceEventRow[]> {
  return dataService.rows<BounceEventRow>(
    `SELECT event_id, provider, event_type, classification, message_id, suppressed, received_at
       FROM deliverability.bounce_event
      WHERE tenant_id = $1 AND ($2::text IS NULL OR classification = $2)
      ORDER BY received_at DESC LIMIT $3`,
    [tenantId, opts.classification ?? null, opts.limit ?? 100],
  );
}
