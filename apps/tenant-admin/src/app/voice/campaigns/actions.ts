'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { gateway, GatewayError } from '../../../lib/gateway';

/**
 * Numbers & campaigns server actions (VA·E9 · TK-4514). Run server-side with the admin's
 * session; outcomes come back to the page as query parameters.
 */

const msg = (err: unknown, fallback: string) => (err instanceof GatewayError ? err.message : fallback);
const str = (form: FormData, k: string) => String(form.get(k) ?? '').trim();
const to = (path: string, params: Record<string, string>): never => redirect(`${path}?${new URLSearchParams(params).toString()}`);

// ---- numbers -------------------------------------------------------------------------------

export async function bindNumberAction(form: FormData): Promise<void> {
  const agentId = str(form, 'agent_id');
  const fallback = str(form, 'fallback');
  try {
    await gateway.post(`/api/voice-agent/agents/${encodeURIComponent(agentId)}/numbers`, {
      phone_number: str(form, 'phone_number'),
      carrier: str(form, 'carrier'),
      fallback,
      ...(str(form, 'fallback_target') ? { fallback_target: str(form, 'fallback_target') } : {}),
    });
  } catch (err) {
    to('/voice/numbers', { error: msg(err, 'Could not bind the number') });
  }
  revalidatePath('/voice/numbers');
  to('/voice/numbers', { bound: str(form, 'phone_number') });
}

export async function unbindNumberAction(form: FormData): Promise<void> {
  try {
    await gateway.del(`/api/voice-agent/agents/${encodeURIComponent(str(form, 'agent_id'))}/numbers/${encodeURIComponent(str(form, 'binding_id'))}`);
  } catch (err) {
    to('/voice/numbers', { error: msg(err, 'Could not unbind the number') });
  }
  revalidatePath('/voice/numbers');
  to('/voice/numbers', { unbound: '1' });
}

// ---- campaigns -----------------------------------------------------------------------------

export async function createCampaignAction(form: FormData): Promise<void> {
  let id = '';
  try {
    const { campaign } = await gateway.post<{ campaign: { campaign_id: string } }>('/api/dialer/campaigns', {
      agent_id: str(form, 'agent_id'),
      name: str(form, 'name'),
      default_timezone: str(form, 'default_timezone'),
      window_start: str(form, 'window_start'),
      window_end: str(form, 'window_end'),
      max_concurrency: Number(str(form, 'max_concurrency') || 5),
      max_attempts: Number(str(form, 'max_attempts') || 3),
      voicemail_policy: str(form, 'voicemail_policy') || 'hang_up',
    });
    id = campaign.campaign_id;
  } catch (err) {
    to('/voice/campaigns', { error: msg(err, 'Could not create the campaign') });
  }
  revalidatePath('/voice/campaigns');
  redirect(`/voice/campaigns/${encodeURIComponent(id)}?created=1`);
}

/**
 * Parses the upload box: one contact per line, `phone_number,subject_ref,timezone,person_id`
 * (only the phone number is required; a header line starting with "phone" is skipped).
 */
export async function parseContactLines(text: string): Promise<Record<string, string>[]> {
  return text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !/^phone/i.test(l))
    .map((l) => {
      const [phone_number, subject_ref, timezone, person_id] = l.split(',').map((c) => c.trim());
      // external_ref is the upsert key: the subject reference when given, else the number, so
      // re-uploading the same list updates contacts rather than duplicating them.
      const c: Record<string, string> = { phone_number, external_ref: subject_ref || phone_number };
      if (subject_ref) c.subject_ref = subject_ref;
      if (timezone) c.timezone = timezone;
      if (person_id) c.person_id = person_id;
      return c;
    });
}

export async function uploadContactsAction(form: FormData): Promise<void> {
  const id = str(form, 'campaign_id');
  const path = `/voice/campaigns/${encodeURIComponent(id)}`;
  const contacts = await parseContactLines(String(form.get('contacts') ?? ''));
  if (contacts.length === 0) to(path, { error: 'Add at least one phone number' });
  let result: { inserted: number; updated: number; rejected: { index: number; reason: string }[] } = { inserted: 0, updated: 0, rejected: [] };
  try {
    result = await gateway.post(`/api/dialer/campaigns/${encodeURIComponent(id)}/contacts`, { contacts });
  } catch (err) {
    to(path, { error: msg(err, 'Could not upload contacts') });
  }
  revalidatePath(path);
  to(path, {
    uploaded: String(result.inserted),
    updated: String(result.updated),
    rejected: String(result.rejected.length),
    ...(result.rejected.length ? { reasons: result.rejected.slice(0, 3).map((r) => `line ${r.index + 1}: ${r.reason}`).join('; ') } : {}),
  });
}

/** start | pause | resume | cancel. */
export async function transitionCampaignAction(form: FormData): Promise<void> {
  const id = str(form, 'campaign_id');
  const action = str(form, 'action');
  const path = `/voice/campaigns/${encodeURIComponent(id)}`;
  try {
    await gateway.post(`/api/dialer/campaigns/${encodeURIComponent(id)}/${encodeURIComponent(action)}`, {});
  } catch (err) {
    to(path, { error: msg(err, `Could not ${action} the campaign`) });
  }
  revalidatePath(path);
  to(path, { did: action });
}
