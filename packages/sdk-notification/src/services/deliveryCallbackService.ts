import { dataService } from '@projexlight/db-runtime';
import { markDelivered } from './notificationService';

/**
 * @projexlight/sdk-notification — provider delivery-status callback ingestion (P14·E4, TK-3636).
 *
 * Normalizes Twilio / SES / SendGrid delivery callbacks to a common status, looks up the
 * notification.message by provider_message_id, drives the sent->delivered transition via
 * the existing markDelivered() (which emits notification.delivered.v1 once), records an
 * idempotent receipt, and feeds delivered/bounce counts to a pluggable reputation hook.
 * Unknown provider message ids are recorded gracefully (matched=false) — no error.
 */

export type NormalizedStatus = 'queued' | 'sent' | 'delivered' | 'failed' | 'bounced' | 'undelivered' | 'complaint';

export interface NormalizedReceipt {
  provider_message_id: string;
  status: NormalizedStatus;
  error_code?: string | null;
}

const lc = (v: unknown): string => String(v ?? '').toLowerCase();

/** Normalize a provider status callback into {provider_message_id, status}. */
export function classifyDeliveryStatus(provider: string, payload: unknown): NormalizedReceipt[] {
  const out: NormalizedReceipt[] = [];
  const p = (payload ?? {}) as Record<string, unknown>;

  // SendGrid: array of event objects.
  if (Array.isArray(payload)) {
    for (const ev of payload as Array<Record<string, unknown>>) {
      const e = lc(ev.event);
      const status: NormalizedStatus | null =
        e === 'delivered' ? 'delivered' : e === 'bounce' ? 'bounced' : e === 'dropped' ? 'failed'
          : e === 'deferred' ? 'sent' : e === 'processed' ? 'sent' : e === 'spamreport' ? 'complaint' : null;
      const id = String(ev.sg_message_id ?? ev.smtp_id ?? '');
      if (status && id) out.push({ provider_message_id: id, status, error_code: ev.reason ? String(ev.reason) : null });
    }
    return out;
  }

  // Twilio: MessageStatus + MessageSid (or normalized message_status/provider_message_id).
  const twilioStatus = lc(p.MessageStatus ?? p.message_status ?? p.status ?? p.SmsStatus);
  const twilioSid = String(p.MessageSid ?? p.provider_message_id ?? p.message_sid ?? '');
  if (twilioSid) {
    const status: NormalizedStatus =
      twilioStatus === 'delivered' ? 'delivered'
        : twilioStatus === 'undelivered' ? 'undelivered'
          : twilioStatus === 'failed' ? 'failed'
            : twilioStatus === 'sent' || twilioStatus === 'queued' || twilioStatus === 'sending' ? 'sent' : 'sent';
    out.push({ provider_message_id: twilioSid, status, error_code: p.ErrorCode ? String(p.ErrorCode) : null });
    return out;
  }

  // SES via SNS: { eventType, mail: { messageId } }.
  const sesType = lc(p.eventType ?? p.notificationType);
  const sesId = String((p.mail as Record<string, unknown> | undefined)?.messageId ?? '');
  if (sesId) {
    const status: NormalizedStatus =
      sesType === 'delivery' ? 'delivered' : sesType === 'bounce' ? 'bounced'
        : sesType === 'complaint' ? 'complaint' : sesType === 'reject' ? 'failed' : 'sent';
    out.push({ provider_message_id: sesId, status });
    return out;
  }
  return out;
}

/* --------------------------------------------------- pluggable reputation hook */

export interface DeliveryReputationEvent {
  tenant_id: string;
  channel: 'email' | 'sms';
  delivered: number;
  bounced: number;
  complained: number;
}
export type DeliveryReputationHook = (e: DeliveryReputationEvent) => Promise<void>;
const defaultRepHook: DeliveryReputationHook = async () => undefined;
let _repHook: DeliveryReputationHook = defaultRepHook;
/** Install the reputation hook (gateway wires to sdk-deliverability recordSendOutcome). */
export function setDeliveryReputationHook(hook: DeliveryReputationHook): void { _repHook = hook; }
export function _resetDeliveryReputationHook(): void { _repHook = defaultRepHook; }

/* ------------------------------------------------------------------ process */

export interface ProcessDeliveryInput {
  tenantId: string;
  provider: string;
  payload: unknown;
  signatureVerified?: boolean;
}
export interface ProcessDeliveryResult {
  processed: number;
  matched: number;
  transitioned: number;
  receipts: Array<{ provider_message_id: string; status: string; matched: boolean }>;
}

/** Process a delivery-status callback: normalize, map to markDelivered, record, feed reputation. */
export async function processDeliveryCallback(input: ProcessDeliveryInput): Promise<ProcessDeliveryResult> {
  const receipts = classifyDeliveryStatus(input.provider, input.payload);
  let matched = 0;
  let transitioned = 0;
  const summary: Array<{ provider_message_id: string; status: string; matched: boolean }> = [];

  for (const r of receipts) {
    // Look up the internal message by provider_message_id (tenant-scoped).
    const msg = await dataService.one<{ message_id: string; channel: string; status: string }>(
      `SELECT message_id, channel, status FROM notification.message
        WHERE tenant_id = $1 AND provider_message_id = $2 LIMIT 1`,
      [input.tenantId, r.provider_message_id],
    );
    const isMatched = msg !== null;
    if (isMatched) matched += 1;

    if (isMatched && r.status === 'delivered' && msg!.status === 'sent') {
      // Drive the state machine + delivered event exactly once (guarded by status='sent').
      await markDelivered(msg!.message_id, r.provider_message_id).then(() => { transitioned += 1; }).catch(() => undefined);
    } else if (isMatched && (r.status === 'failed' || r.status === 'bounced' || r.status === 'undelivered')) {
      await dataService.rows(
        `UPDATE notification.message SET status = 'failed' WHERE message_id = $1 AND status <> 'delivered'`,
        [msg!.message_id],
      );
    }

    await dataService.rows(
      `INSERT INTO notification.delivery_receipt
         (tenant_id, provider, provider_message_id, message_id, status, error_code, matched, signature_verified, raw)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb)
       ON CONFLICT (provider, provider_message_id, status) DO NOTHING`,
      [input.tenantId, input.provider, r.provider_message_id, msg?.message_id ?? null, r.status,
       r.error_code ?? null, isMatched, input.signatureVerified ?? false, JSON.stringify({ status: r.status })],
    );

    // Feed reputation (email/sms only) — delivered/bounced/complaint counts.
    const channel = msg?.channel === 'sms' ? 'sms' : 'email';
    if (r.status === 'delivered' || r.status === 'bounced' || r.status === 'complaint') {
      await _repHook({
        tenant_id: input.tenantId, channel,
        delivered: r.status === 'delivered' ? 1 : 0,
        bounced: r.status === 'bounced' ? 1 : 0,
        complained: r.status === 'complaint' ? 1 : 0,
      }).catch(() => undefined);
    }
    summary.push({ provider_message_id: r.provider_message_id, status: r.status, matched: isMatched });
  }
  return { processed: receipts.length, matched, transitioned, receipts: summary };
}

export interface DeliveryReceiptRow {
  receipt_id: string; provider: string; provider_message_id: string; status: string;
  matched: boolean; error_code: string | null; received_at: string;
}
/** List a tenant's delivery receipts, newest first. */
export async function listDeliveryReceipts(tenantId: string, opts: { status?: string; limit?: number } = {}): Promise<DeliveryReceiptRow[]> {
  return dataService.rows<DeliveryReceiptRow>(
    `SELECT receipt_id, provider, provider_message_id, status, matched, error_code, received_at
       FROM notification.delivery_receipt
      WHERE tenant_id = $1 AND ($2::text IS NULL OR status = $2)
      ORDER BY received_at DESC LIMIT $3`,
    [tenantId, opts.status ?? null, opts.limit ?? 100],
  );
}
