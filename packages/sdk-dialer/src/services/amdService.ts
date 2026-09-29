import { dataService } from '@projexlight/db-runtime';
import { conflict, notFound, validationError } from '../models/errors';

/**
 * Answering-machine handling (VA·E5 · TK-4486).
 *
 * The carrier's AMD result for an outbound call arrives here (from the voice runtime or
 * the telephony connector's status callback). The dialer records answered_by on the call
 * and answers with what to do next:
 *
 *   human / unknown  -> connect   (unknown is treated as a person: dropping a message on a
 *                                  live human is worse than a missed voicemail)
 *   machine          -> the campaign's voicemail policy:
 *                        drop_tts        speak voicemail_message, then hang up
 *                        drop_recording  play the recording voicemail_message refers to
 *                        hang_up         leave nothing
 *                       API calls (no campaign) use DIALER_DEFAULT_VOICEMAIL_POLICY
 *                       (default hang_up). The call's disposition becomes 'voicemail' and
 *                       the action is recorded in voicemail_action.
 *
 * Idempotent: repeating a report returns the same decision without re-recording it.
 */

export const ANSWERED_BY = ['human', 'machine', 'unknown'] as const;
export type AnsweredBy = (typeof ANSWERED_BY)[number];
export type AmdAction = 'connect' | 'drop_tts' | 'drop_recording' | 'hang_up';

export interface AmdDecision {
  call_id: string;
  answered_by: AnsweredBy;
  action: AmdAction;
  /** TTS text (drop_tts) or recording reference (drop_recording). */
  message: string | null;
  /** Where the policy came from: the call's campaign, or the platform default. */
  policy_source: 'campaign' | 'default';
}

const ACTIVE = ['dialing', 'ringing', 'in_progress'];
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Records the AMD result and returns the action for the runtime.
 *
 * @throws DialerError 400 invalid answered_by, 404 unknown call, 409 not an active
 *   outbound call, or a different answered_by was already recorded.
 */
export async function reportAmd(tenantId: string, callId: string, input: { answered_by?: unknown }): Promise<AmdDecision> {
  if (!(ANSWERED_BY as readonly unknown[]).includes(input.answered_by)) throw validationError('answered_by must be human, machine or unknown');
  const answeredBy = input.answered_by as AnsweredBy;
  if (!UUID_RE.test(callId)) throw notFound('call not found');
  const call = await dataService.one<{ direction: string; status: string; answered_by: string | null; voicemail_action: string | null; campaign_id: string | null }>(
    `SELECT c.direction, c.status, c.answered_by, c.voicemail_action, q.campaign_id
       FROM voice_agent.call c LEFT JOIN dialer.dispatch_queue q ON q.call_id = c.call_id
      WHERE c.tenant_id = $1 AND c.call_id = $2`,
    [tenantId, callId],
  );
  if (!call) throw notFound('call not found');
  if (call.direction !== 'outbound') throw conflict('answering-machine detection applies to outbound calls');
  if (call.answered_by && call.answered_by !== answeredBy) throw conflict(`answered_by was already recorded as ${call.answered_by}`);
  if (!call.answered_by && !ACTIVE.includes(call.status)) throw conflict(`call is ${call.status}, not active`);

  const policy = await policyFor(tenantId, call.campaign_id);
  const decision: AmdDecision = answeredBy === 'machine'
    ? { call_id: callId, answered_by: answeredBy, action: policy.policy, message: policy.policy === 'hang_up' ? null : policy.message, policy_source: policy.source }
    : { call_id: callId, answered_by: answeredBy, action: 'connect', message: null, policy_source: policy.source };

  if (!call.answered_by) {
    await dataService.query(
      `UPDATE voice_agent.call
          SET answered_by = $3,
              answered_at = COALESCE(answered_at, now()),
              voicemail_action = $4,
              disposition = CASE WHEN $3 = 'machine' THEN 'voicemail' ELSE disposition END,
              status = CASE WHEN status IN ('dialing','ringing') THEN 'in_progress' ELSE status END,
              updated_at = now()
        WHERE tenant_id = $1 AND call_id = $2`,
      [tenantId, callId, answeredBy, answeredBy === 'machine' ? decision.action : null],
    );
  }
  return decision;
}

async function policyFor(tenantId: string, campaignId: string | null): Promise<{ policy: Exclude<AmdAction, 'connect'>; message: string | null; source: 'campaign' | 'default' }> {
  if (campaignId) {
    const c = await dataService.one<{ voicemail_policy: Exclude<AmdAction, 'connect'>; voicemail_message: string | null }>(
      `SELECT voicemail_policy, voicemail_message FROM dialer.campaign WHERE tenant_id = $1 AND campaign_id = $2`,
      [tenantId, campaignId],
    );
    if (c) return { policy: c.voicemail_policy, message: c.voicemail_message, source: 'campaign' };
  }
  const env = process.env.DIALER_DEFAULT_VOICEMAIL_POLICY;
  const policy = env === 'drop_tts' || env === 'drop_recording' ? env : 'hang_up';
  const message = process.env.DIALER_DEFAULT_VOICEMAIL_MESSAGE || null;
  // A drop policy with nothing to drop degrades to hang_up rather than leaving silence.
  return { policy: policy !== 'hang_up' && !message ? 'hang_up' : policy, message, source: 'default' };
}
