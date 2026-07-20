import { createHmac, timingSafeEqual } from 'crypto';
import { dataService } from '@projexlight/db-runtime';

/**
 * @projexlight/sdk-notification — inbound SMS + STOP/HELP/START keyword handler (P14·E4, TK-3634).
 *
 * Classifies an inbound SMS body into opt_out / opt_in / help / none (case-insensitive,
 * per the CTIA keyword conventions), records it idempotently, and routes the intent to a
 * pluggable consent handler (the gateway wires it to sdk-deliverability suppress/unsuppress
 * for the sms channel). HELP returns the tenant's configured auto-reply. Signature is
 * HMAC-verified when a per-tenant secret is configured, else accepted (dev).
 */

export type KeywordIntent = 'opt_out' | 'opt_in' | 'help' | 'none';

// CTIA keyword families (case-insensitive, punctuation-stripped, first token).
const OPT_OUT = new Set(['stop', 'stopall', 'unsubscribe', 'cancel', 'end', 'quit', 'optout', 'revoke']);
const OPT_IN = new Set(['start', 'unstop', 'yes', 'optin', 'subscribe']);
const HELP = new Set(['help', 'info']);

/** Classify an SMS body's leading keyword. Only the FIRST word is a control keyword. */
export function classifyKeyword(body: string | undefined | null): KeywordIntent {
  const first = String(body ?? '').trim().toLowerCase().replace(/[^a-z]/g, ' ').split(/\s+/)[0] || '';
  if (OPT_OUT.has(first)) return 'opt_out';
  if (OPT_IN.has(first)) return 'opt_in';
  if (HELP.has(first)) return 'help';
  return 'none';
}

/* -------------------------------------------------- pluggable consent handler */

export interface SmsConsentEvent {
  tenant_id: string;
  from_number: string;
  intent: KeywordIntent;
}
export type SmsConsentHandler = (e: SmsConsentEvent) => Promise<{ action: string } | void>;
const defaultConsentHandler: SmsConsentHandler = async () => undefined;
let _consentHandler: SmsConsentHandler = defaultConsentHandler;
/** Install the consent handler (gateway wires opt_out->suppress / opt_in->unsuppress). */
export function setSmsConsentHandler(handler: SmsConsentHandler): void { _consentHandler = handler; }
export function _resetSmsConsentHandler(): void { _consentHandler = defaultConsentHandler; }

/* ----------------------------------------------------------------- settings */

export interface SmsSettingsRow {
  tenant_id: string;
  signing_secret: string | null;
  help_reply: string;
  opt_out_reply: string;
  opt_in_reply: string;
}

/** Configure a tenant's inbound-SMS settings (signing secret + auto-reply text). */
export async function upsertSmsSettings(input: {
  tenantId: string; signingSecret?: string; helpReply?: string; optOutReply?: string; optInReply?: string;
}): Promise<SmsSettingsRow> {
  const rows = await dataService.rows<SmsSettingsRow>(
    `INSERT INTO notification.sms_settings (tenant_id, signing_secret, help_reply, opt_out_reply, opt_in_reply)
     VALUES ($1,$2,
       COALESCE($3, 'Reply STOP to unsubscribe, START to resubscribe. Msg&data rates may apply.'),
       COALESCE($4, 'You have been unsubscribed and will receive no more messages. Reply START to resubscribe.'),
       COALESCE($5, 'You have been resubscribed. Reply STOP to unsubscribe.'))
     ON CONFLICT (tenant_id) DO UPDATE SET
       signing_secret = COALESCE(EXCLUDED.signing_secret, notification.sms_settings.signing_secret),
       help_reply = COALESCE($3, notification.sms_settings.help_reply),
       opt_out_reply = COALESCE($4, notification.sms_settings.opt_out_reply),
       opt_in_reply = COALESCE($5, notification.sms_settings.opt_in_reply),
       updated_at = now()
     RETURNING tenant_id, signing_secret, help_reply, opt_out_reply, opt_in_reply`,
    [input.tenantId, input.signingSecret ?? null, input.helpReply ?? null, input.optOutReply ?? null, input.optInReply ?? null],
  );
  return rows[0];
}

async function getSmsSettings(tenantId: string): Promise<SmsSettingsRow | null> {
  return dataService.one<SmsSettingsRow>(
    `SELECT tenant_id, signing_secret, help_reply, opt_out_reply, opt_in_reply
       FROM notification.sms_settings WHERE tenant_id = $1`,
    [tenantId],
  );
}

/**
 * Verify the inbound webhook signature. Accepted (enforced=false) when no per-tenant
 * signing secret is configured; otherwise the HMAC-SHA256 of the raw body must match.
 */
export async function verifyInboundSmsSignature(
  tenantId: string, rawBody: string, signature: string | undefined,
): Promise<{ verified: boolean; enforced: boolean }> {
  const settings = await getSmsSettings(tenantId);
  if (!settings?.signing_secret) return { verified: true, enforced: false };
  if (!signature) return { verified: false, enforced: true };
  const digest = createHmac('sha256', settings.signing_secret).update(rawBody, 'utf8').digest();
  const candidates = [Buffer.from(signature, 'base64'), Buffer.from(signature, 'hex')];
  const verified = candidates.some((c) => c.length === digest.length && timingSafeEqual(c, digest));
  return { verified, enforced: true };
}

/* ----------------------------------------------------------------- process */

export interface InboundSmsInput {
  tenantId: string;
  provider?: string;
  fromNumber: string;
  toNumber?: string;
  body?: string;
  messageSid?: string;
  signatureVerified?: boolean;
}
export interface InboundSmsResult {
  intent: KeywordIntent;
  reply: string | null;
  action_taken: string | null;
  duplicate: boolean;
  inbound_id: string | null;
}

/**
 * Process one inbound SMS: classify the keyword, record it (idempotent per provider +
 * message_sid), route opt_out/opt_in to the consent handler, and return the auto-reply
 * (HELP/opt-out/opt-in text; none/unknown -> no reply).
 */
export async function processInboundSms(input: InboundSmsInput): Promise<InboundSmsResult> {
  const intent = classifyKeyword(input.body);
  const settings = await getSmsSettings(input.tenantId);
  const reply =
    intent === 'help' ? (settings?.help_reply ?? 'Reply STOP to unsubscribe, START to resubscribe.')
      : intent === 'opt_out' ? (settings?.opt_out_reply ?? 'You have been unsubscribed. Reply START to resubscribe.')
        : intent === 'opt_in' ? (settings?.opt_in_reply ?? 'You have been resubscribed. Reply STOP to unsubscribe.')
          : null;

  let action: string | null = null;
  if (intent === 'opt_out' || intent === 'opt_in') {
    const r = await _consentHandler({ tenant_id: input.tenantId, from_number: input.fromNumber, intent }).catch(() => undefined);
    action = r?.action ?? (intent === 'opt_out' ? 'suppressed' : 'resubscribed');
  }

  const rows = await dataService.rows<{ inbound_id: string }>(
    `INSERT INTO notification.sms_inbound
       (tenant_id, provider, from_number, to_number, body, message_sid, keyword_intent, action_taken, reply_sent, signature_verified)
     VALUES ($1,COALESCE($2,'twilio'),$3,$4,$5,$6,$7,$8,$9,$10)
     ON CONFLICT (provider, message_sid) DO NOTHING
     RETURNING inbound_id`,
    [input.tenantId, input.provider ?? null, input.fromNumber, input.toNumber ?? null, input.body ?? null,
     input.messageSid ?? null, intent, action, reply, input.signatureVerified ?? false],
  );
  if (!rows[0]) {
    return { intent, reply, action_taken: action, duplicate: true, inbound_id: null };
  }
  return { intent, reply, action_taken: action, duplicate: false, inbound_id: rows[0].inbound_id };
}

/** List a tenant's inbound SMS, newest first. */
export interface SmsInboundRow {
  inbound_id: string; from_number: string; body: string | null; keyword_intent: string;
  action_taken: string | null; received_at: string;
}
export async function listInboundSms(tenantId: string, opts: { intent?: string; limit?: number } = {}): Promise<SmsInboundRow[]> {
  return dataService.rows<SmsInboundRow>(
    `SELECT inbound_id, from_number, body, keyword_intent, action_taken, received_at
       FROM notification.sms_inbound
      WHERE tenant_id = $1 AND ($2::text IS NULL OR keyword_intent = $2)
      ORDER BY received_at DESC LIMIT $3`,
    [tenantId, opts.intent ?? null, opts.limit ?? 100],
  );
}
