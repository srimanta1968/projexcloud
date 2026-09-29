import { dataService } from '@projexlight/db-runtime';
import { getCampaign, publishProgress } from './campaignService';

/**
 * Campaign retry policy (VA·E5 · TK-4487), applied when a campaign call ends.
 *
 * Unanswered outcomes — no_answer, busy, voicemail, failed — put the contact back to
 * pending with next_attempt_at = now + retry_spacing_minutes[attempts - 1] (the last
 * spacing repeats), until the campaign's max_attempts is reached; then the contact is
 * failed ("retries_exhausted"). Any other outcome (the person was reached) makes the
 * contact done. The contact feeder dials pending contacts once they are due.
 *
 * When a running campaign has nobody left to call it is marked completed.
 */

export const RETRYABLE_OUTCOMES = ['no_answer', 'busy', 'voicemail', 'failed'] as const;

export interface EndedCall {
  tenant_id: string;
  call_id: string;
  status: string;
  disposition: string | null;
}

export interface RetryOutcome {
  contact_id: string;
  contact_status: 'pending' | 'done' | 'failed';
  next_attempt_at: string | null;
  attempts: number;
}

/** Applies the retry policy for the contact whose call just ended; null when it was not a campaign call. */
export async function applyRetryPolicy(call: EndedCall): Promise<RetryOutcome | null> {
  const row = await dataService.one<{
    contact_id: string; campaign_id: string; attempts: number; max_attempts: number; retry_spacing_minutes: number[]; campaign_status: string;
  }>(
    `SELECT k.contact_id, k.campaign_id, k.attempts, c.max_attempts, c.retry_spacing_minutes, c.status AS campaign_status
       FROM dialer.campaign_contact k JOIN dialer.campaign c ON c.campaign_id = k.campaign_id AND c.tenant_id = k.tenant_id
      WHERE k.tenant_id = $1 AND k.last_call_id = $2`,
    [call.tenant_id, call.call_id],
  );
  if (!row) return null;

  const outcome = call.disposition ?? (call.status === 'failed' ? 'failed' : 'no_answer');
  const retryable = (RETRYABLE_OUTCOMES as readonly string[]).includes(outcome);
  let status: RetryOutcome['contact_status'];
  let next: Date | null = null;
  let lastOutcome = outcome;
  if (!retryable) {
    status = 'done';
  } else if (row.attempts < row.max_attempts) {
    const spacing = row.retry_spacing_minutes;
    const minutes = spacing[Math.min(Math.max(row.attempts - 1, 0), spacing.length - 1)];
    next = new Date(Date.now() + minutes * 60_000);
    status = 'pending';
  } else {
    status = 'failed';
    lastOutcome = `retries_exhausted:${outcome}`;
  }
  await dataService.query(
    `UPDATE dialer.campaign_contact SET status = $3, next_attempt_at = $4::timestamptz, last_outcome = $5, updated_at = now()
      WHERE tenant_id = $1 AND contact_id = $2`,
    [call.tenant_id, row.contact_id, status, next ? next.toISOString() : null, lastOutcome],
  );
  await completeIfFinished(call.tenant_id, row.campaign_id);
  return { contact_id: row.contact_id, contact_status: status, next_attempt_at: next ? next.toISOString() : null, attempts: row.attempts };
}

/** Marks a running campaign completed once no contact is left to call or in a call. */
async function completeIfFinished(tenantId: string, campaignId: string): Promise<void> {
  const done = await dataService.one<{ campaign_id: string }>(
    `UPDATE dialer.campaign SET status = 'completed', finished_at = now(), updated_at = now()
      WHERE tenant_id = $1 AND campaign_id = $2 AND status = 'running'
        AND NOT EXISTS (SELECT 1 FROM dialer.campaign_contact
                         WHERE tenant_id = $1 AND campaign_id = $2 AND status IN ('pending','queued','in_progress','deferred'))
      RETURNING campaign_id`,
    [tenantId, campaignId],
  );
  const campaign = await getCampaign(tenantId, campaignId);
  if (campaign) await publishProgress(tenantId, campaign, { force: !!done, actorId: null, action: done ? 'completed' : 'call_ended' });
}
