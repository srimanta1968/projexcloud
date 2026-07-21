import { dataService } from '@projexlight/db-runtime';
import { emitEvent } from '@projexlight/sdk-audit';
import { getTwilioVoiceProvider, TwilioVoiceProviderError } from '../provider';
import { getTrackingNumber, recordingCallbackUrl, statusCallbackUrl } from './numberService';
import type { PlaceCallInput, VoiceCallRecord } from '../models/voice.model';

/**
 * Outbound call placement for connector-twilio-voice (P15·E4, TK-3652).
 *
 * placeCall always asks Twilio for a status callback and (by default) a
 * recording plus answering-machine detection, so the status/recording webhooks
 * (TK-3653) can complete the call record and classify voicemail. The mirror row
 * is written in 'queued' before the webhooks start arriving.
 */

const VOICE_AUDIT_POOL = process.env.TWILIO_VOICE_AUDIT_POOL || 'admin-default';

export const CALL_COLS = `
  voice_call_id, install_id, tenant_id, external_id, direction, from_number,
  to_number, tracking_number_id, subject_persona_id, initiated_by_persona_id,
  status, answered_by, duration_seconds, recording_url, recording_sid,
  recording_duration_seconds, is_voicemail, voicemail_transcript, error_code,
  payload, started_at, answered_at, ended_at, last_sync_at`;

/** Thrown when no caller-id can be resolved for the outbound leg. */
export class NoCallerIdAvailable extends Error {
  constructor() {
    super('[connector-twilio-voice] no from_number and no active tracking number to call from');
    this.name = 'NoCallerIdAvailable';
  }
}

/**
 * Place an outbound call.
 *
 * Caller id resolution: an explicit from_number wins; otherwise the referenced
 * tracking number is used; otherwise the tenant's most recent ACTIVE tracking
 * number. If none exists the call is rejected rather than dialled from an
 * arbitrary number.
 *
 * Recording and AMD default ON: the SOP wants the recording, and AMD is what
 * lets the status webhook tell a human answer from a voicemail. Callers can
 * opt out per call (e.g. a jurisdiction where recording consent was refused —
 * see the sdk-consent gate in TK-3654).
 *
 * @throws NoCallerIdAvailable when no caller id can be resolved.
 * @throws TwilioVoiceProviderError when the upstream call request fails.
 */
export async function placeCall(input: PlaceCallInput): Promise<VoiceCallRecord> {
  const from_number = await resolveCallerId(input);
  if (!from_number) throw new NoCallerIdAvailable();

  const record = input.record ?? true;
  const machine_detection = input.machine_detection ?? true;

  let placed;
  try {
    placed = await getTwilioVoiceProvider().placeCall({
      to: input.to_number,
      from: from_number.phone_number,
      status_callback_url: statusCallbackUrl(),
      recording_status_callback_url: record ? recordingCallbackUrl() : null,
      record,
      machine_detection,
    });
  } catch (err) {
    throw new TwilioVoiceProviderError(
      `call placement failed: ${(err as Error).message}`,
      'Check the Twilio credentials, that the from number is voice-capable and owned by the account, and that the destination is not on a geo-permission block.',
    );
  }

  const rec = await dataService.one<VoiceCallRecord>(
    `INSERT INTO connector_twilio_voice.voice_call
       (install_id, tenant_id, external_id, direction, from_number, to_number,
        tracking_number_id, subject_persona_id, initiated_by_persona_id, status, payload)
     VALUES ($1, $2, $3, 'outbound', $4, $5, $6, $7, $8, $9,
             COALESCE($10::jsonb, '{}'::jsonb))
     ON CONFLICT (install_id, external_id) DO UPDATE SET last_sync_at = now()
     RETURNING ${CALL_COLS}`,
    [
      input.install_id,
      input.tenant_id,
      placed.sid,
      from_number.phone_number,
      input.to_number,
      from_number.tracking_number_id,
      input.subject_persona_id ?? null,
      input.initiated_by_persona_id ?? null,
      normalizeStatus(placed.status) ?? 'queued',
      JSON.stringify({ ...(input.metadata ?? {}), record, machine_detection }),
    ],
  );
  if (!rec) throw new Error('[connector-twilio-voice] voice_call insert returned no row');

  await emitEvent({
    event_type: 'twilio-voice.call.placed.v1',
    pool_index: VOICE_AUDIT_POOL,
    actor_kind: 'service',
    actor_id: 'connector-twilio-voice',
    tenant_id: rec.tenant_id,
    subject_kind: 'connector_twilio_voice.voice_call',
    subject_id: rec.voice_call_id,
    payload: {
      external_id: rec.external_id,
      to_number: rec.to_number,
      from_number: rec.from_number,
      record,
      machine_detection,
    },
  });
  return rec;
}

/** Resolve which number the outbound leg should originate from. */
async function resolveCallerId(
  input: PlaceCallInput,
): Promise<{ phone_number: string; tracking_number_id: string | null } | null> {
  if (input.from_number) {
    return { phone_number: input.from_number, tracking_number_id: input.tracking_number_id ?? null };
  }
  if (input.tracking_number_id) {
    const tn = await getTrackingNumber(input.tenant_id, input.tracking_number_id);
    if (tn && tn.status === 'active') {
      return { phone_number: tn.phone_number, tracking_number_id: tn.tracking_number_id };
    }
    return null;
  }
  const fallback = await dataService.one<{ phone_number: string; tracking_number_id: string }>(
    `SELECT phone_number, tracking_number_id
       FROM connector_twilio_voice.tracking_number
      WHERE tenant_id = $1 AND status = 'active'
      ORDER BY provisioned_at DESC
      LIMIT 1`,
    [input.tenant_id],
  );
  return fallback ? { phone_number: fallback.phone_number, tracking_number_id: fallback.tracking_number_id } : null;
}

/** Map a provider status string onto the DB vocabulary, or null when unknown. */
export function normalizeStatus(status: string | null | undefined): string | null {
  if (!status) return null;
  const s = status.toLowerCase().replace(/_/g, '-');
  const allowed = ['queued', 'initiated', 'ringing', 'in-progress', 'completed', 'busy', 'no-answer', 'canceled', 'failed'];
  if (allowed.includes(s)) return s;
  if (s === 'cancelled') return 'canceled';   // accept the double-l spelling
  if (s === 'answered') return 'in-progress';
  return null;
}

/** Fetch one tenant-scoped call, or null. */
export async function getCall(tenant_id: string, voice_call_id: string): Promise<VoiceCallRecord | null> {
  return dataService.one<VoiceCallRecord>(
    `SELECT ${CALL_COLS} FROM connector_twilio_voice.voice_call
      WHERE tenant_id = $1 AND voice_call_id = $2`,
    [tenant_id, voice_call_id],
  );
}

/** List a tenant's calls, newest first, optionally filtered. */
export async function listCalls(
  tenant_id: string,
  opts: { status?: string; direction?: string; is_voicemail?: boolean; limit?: number; offset?: number } = {},
): Promise<VoiceCallRecord[]> {
  return dataService.rows<VoiceCallRecord>(
    `SELECT ${CALL_COLS} FROM connector_twilio_voice.voice_call
      WHERE tenant_id = $1
        AND ($2::text IS NULL OR status = $2)
        AND ($3::text IS NULL OR direction = $3)
        AND ($4::boolean IS NULL OR is_voicemail = $4)
      ORDER BY started_at DESC
      LIMIT $5 OFFSET $6`,
    [tenant_id, opts.status ?? null, opts.direction ?? null, opts.is_voicemail ?? null, opts.limit ?? 50, opts.offset ?? 0],
  );
}
