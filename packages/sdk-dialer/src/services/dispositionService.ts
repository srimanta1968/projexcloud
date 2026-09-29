import { dataService } from '@projexlight/db-runtime';
import { emitEvent } from '@projexlight/sdk-audit';
import { revokeConsent } from '@projexlight/sdk-consent';
import { suppressionService } from '@projexlight/sdk-deliverability';
import { VOICE_CONSENT_PURPOSE } from './complianceGates';

/**
 * Disposition taxonomy and opt-out automation (VA·E5 · TK-4488).
 *
 * Every AI call ends with one disposition from DISPOSITIONS (the voice_agent.call CHECK
 * constraint is the source of truth). The taxonomy says what each one means to the
 * dialer: was the person reached, may the contact be retried, and which telephony-level
 * disposition the CRM activity timeline records.
 *
 * opt_out is automated: when a call ends with it, the dialer
 *   1. writes a tenant-scoped 'voice' suppression (reason optout) for the number, so the
 *      DNC gate refuses every later call to it from this tenant, and
 *   2. revokes the person's active ai_voice_outbound consent receipts that belong to this
 *      tenant (source_tenant_id = tenant) or carry no tenant, so the consent gate refuses
 *      too — and emits voice.call.opted_out.v1 for the audit chain.
 * Both steps are idempotent, so a repeated end-of-call report changes nothing.
 */

export interface DispositionInfo {
  code: string;
  /** The person was actually spoken to. */
  reached: boolean;
  /** An attempt with this outcome may be retried under the campaign retry policy. */
  retryable: boolean;
  /** sdk-crm call_disposition the CRM activity records. */
  crm_disposition: 'answered' | 'no_answer' | 'busy' | 'failed' | 'voicemail';
  description: string;
}

export const DISPOSITIONS: DispositionInfo[] = [
  { code: 'connected_qualified', reached: true, retryable: false, crm_disposition: 'answered', description: 'Reached and qualified' },
  { code: 'connected_not_interested', reached: true, retryable: false, crm_disposition: 'answered', description: 'Reached, not interested' },
  { code: 'callback_requested', reached: true, retryable: false, crm_disposition: 'answered', description: 'Reached, asked to be called back later' },
  { code: 'meeting_booked', reached: true, retryable: false, crm_disposition: 'answered', description: 'Reached and booked a meeting' },
  { code: 'voicemail', reached: false, retryable: true, crm_disposition: 'voicemail', description: 'Answering machine; voicemail policy applied' },
  { code: 'no_answer', reached: false, retryable: true, crm_disposition: 'no_answer', description: 'Rang out unanswered' },
  { code: 'busy', reached: false, retryable: true, crm_disposition: 'busy', description: 'Line busy' },
  { code: 'wrong_number', reached: true, retryable: false, crm_disposition: 'answered', description: 'Reached the wrong person' },
  { code: 'opt_out', reached: true, retryable: false, crm_disposition: 'answered', description: 'Asked not to be called again: number suppressed, AI-call consent revoked' },
  { code: 'failed', reached: false, retryable: true, crm_disposition: 'failed', description: 'Technical failure before anyone was reached' },
];

const DIALER_AUDIT_POOL = process.env.DIALER_AUDIT_POOL || 'admin-default';

export interface EndedCallForDisposition {
  tenant_id: string;
  call_id: string;
  disposition: string | null;
  to_number: string | null;
  from_number: string | null;
  direction: string;
  person_id?: string | null;
}

export interface OptOutResult {
  suppressed: boolean;
  revoked_receipts: string[];
}

/** Applies disposition side effects for an ended call; today that is opt-out automation. */
export async function applyDispositionEffects(call: EndedCallForDisposition): Promise<OptOutResult | null> {
  if (call.disposition !== 'opt_out') return null;
  // The number to stop calling is the other party: the one we dialled, or who dialled us.
  const number = call.direction === 'inbound' ? call.from_number : call.to_number;
  let suppressed = false;
  if (number) {
    await suppressionService.suppress({
      tenantId: call.tenant_id,
      channel: 'voice',
      address: number,
      reason: 'optout',
      reasonDetail: 'Opted out on an AI voice call',
      source: `voice-agent:${call.call_id}`,
    });
    suppressed = true;
  }

  const revoked: string[] = [];
  if (call.person_id) {
    const receipts = await dataService.rows<{ receipt_id: string }>(
      `SELECT receipt_id FROM consent.receipt
        WHERE person_id = $1 AND purpose_id = $2 AND revoked_at IS NULL
          AND (source_tenant_id = $3 OR source_tenant_id IS NULL)`,
      [call.person_id, VOICE_CONSENT_PURPOSE, call.tenant_id],
    );
    for (const r of receipts) {
      await revokeConsent(r.receipt_id, {
        revoked_by: 'sdk-dialer.opt-out',
        reason: `Opted out on AI voice call ${call.call_id}`,
        authenticated_actor_kind: 'service',
      });
      revoked.push(r.receipt_id);
    }
  }

  await emitEvent({
    event_type: 'voice.call.opted_out.v1',
    pool_index: DIALER_AUDIT_POOL,
    actor_kind: 'service',
    actor_id: 'sdk-dialer.opt-out',
    tenant_id: call.tenant_id,
    subject_kind: 'voice_agent.call',
    subject_id: call.call_id,
    payload: { call_id: call.call_id, suppressed, revoked_receipts: revoked, purpose: VOICE_CONSENT_PURPOSE },
  });
  return { suppressed, revoked_receipts: revoked };
}
