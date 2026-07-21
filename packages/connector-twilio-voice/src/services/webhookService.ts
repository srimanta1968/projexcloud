import { createHmac, timingSafeEqual } from 'crypto';
import { dataService } from '@projexlight/db-runtime';
import { emitEvent } from '@projexlight/sdk-audit';
import { CALL_COLS, normalizeStatus } from './callService';
import { isVoicemailOutcome, type VoiceCallRecord } from '../models/voice.model';

/**
 * Twilio status / recording webhook ingestion (P15·E4, TK-3653).
 *
 * Twilio pushes call progress and recording availability to public endpoints.
 * They authenticate by SIGNATURE, not by tenant JWT, so the gateway allowlists
 * /api/voice/webhooks/ and verification happens here.
 *
 * The two hard requirements of a webhook sink are met deliberately:
 *  - IDEMPOTENT: callbacks are retried and can arrive out of order, so updates
 *    are keyed on the Call SID and a status is never allowed to move backwards
 *    out of a terminal state.
 *  - NEVER ERROR-LOOP: an unknown Call SID is acknowledged, not 500'd, or Twilio
 *    would retry forever against a call we will never know about.
 */

const VOICE_AUDIT_POOL = process.env.TWILIO_VOICE_AUDIT_POOL || 'admin-default';

/* ------------------------------------------------------------------ signature */

/**
 * Verify Twilio's X-Twilio-Signature.
 *
 * Twilio's scheme: HMAC-SHA1, keyed with the account auth token, over the full
 * request URL followed by every POST parameter appended as key+value in
 * lexicographic key order; the digest is base64.
 *
 * Enforcement is conditional on TWILIO_AUTH_TOKEN being configured: an
 * unconfigured environment accepts the callback (enforced:false) so local and
 * test runs work, exactly like the sdk-deliverability provider webhooks. Once a
 * token IS set, a missing or wrong signature fails closed.
 */
export function verifyTwilioSignature(
  url: string,
  params: Record<string, string>,
  signature: string | undefined,
): { verified: boolean; enforced: boolean } {
  const token = process.env.TWILIO_AUTH_TOKEN;
  if (!token) return { verified: true, enforced: false };
  if (!signature) return { verified: false, enforced: true };

  let payload = url;
  for (const key of Object.keys(params).sort()) payload += key + params[key];
  const digest = createHmac('sha1', token).update(payload, 'utf8').digest();
  const provided = Buffer.from(signature, 'base64');
  const verified = provided.length === digest.length && timingSafeEqual(provided, digest);
  return { verified, enforced: true };
}

/* ------------------------------------------------------------- status ingest */

/**
 * Rank of each call status for the regression guard. Terminal states share the
 * top rank: once a call is completed/failed/busy/no-answer/canceled, a late
 * 'ringing' retry must not drag it back.
 */
const STATUS_RANK: Record<string, number> = {
  queued: 0, initiated: 1, ringing: 2, 'in-progress': 3,
  completed: 4, busy: 4, 'no-answer': 4, canceled: 4, failed: 4,
};

export interface StatusCallbackResult {
  matched: boolean;
  call?: VoiceCallRecord;
  /** True when this callback flipped the call to voicemail. */
  voicemail_detected?: boolean;
  ignored_reason?: string;
}

/**
 * Apply a Twilio call status callback.
 *
 * Recognised params: CallSid, CallStatus, AnsweredBy (AMD), CallDuration, To,
 * From, ErrorCode. AMD is what turns a call into a voicemail: an AnsweredBy of
 * machine_start / machine_end_* marks is_voicemail. 'unknown' and 'fax' are
 * deliberately NOT voicemail — 'unknown' means detection was inconclusive and
 * treating it as voicemail would log phantom voicemails against the contact.
 *
 * Unknown Call SIDs are reported as unmatched (the caller acknowledges with 202)
 * rather than raising, so Twilio does not retry indefinitely.
 */
export async function applyStatusCallback(params: Record<string, string>): Promise<StatusCallbackResult> {
  const sid = params.CallSid || params.callSid;
  if (!sid) return { matched: false, ignored_reason: 'no CallSid in payload' };

  const existing = await findCallBySid(sid);
  if (!existing) return { matched: false, ignored_reason: `unknown CallSid ${sid}` };

  const incoming = normalizeStatus(params.CallStatus);
  const answered_by = normalizeAnsweredBy(params.AnsweredBy);
  const duration = params.CallDuration ? Number(params.CallDuration) : null;

  // Regression guard: keep the furthest-progressed status we have seen.
  const keepCurrent =
    !incoming || (STATUS_RANK[existing.status] ?? 0) > (STATUS_RANK[incoming] ?? 0);
  const nextStatus = keepCurrent ? existing.status : incoming;

  // Voicemail is sticky: once AMD says machine, a later callback without
  // AnsweredBy must not clear it.
  const voicemail = existing.is_voicemail || isVoicemailOutcome(answered_by);
  const voicemail_detected = voicemail && !existing.is_voicemail;

  const rec = await dataService.one<VoiceCallRecord>(
    `UPDATE connector_twilio_voice.voice_call
        SET status           = $2,
            answered_by      = COALESCE($3, answered_by),
            duration_seconds = COALESCE($4, duration_seconds),
            error_code       = COALESCE($5, error_code),
            is_voicemail     = $6,
            answered_at      = CASE WHEN $2 = 'in-progress' THEN COALESCE(answered_at, now()) ELSE answered_at END,
            ended_at         = CASE WHEN $2 IN ('completed','busy','no-answer','canceled','failed')
                                    THEN COALESCE(ended_at, now()) ELSE ended_at END,
            payload          = payload || $7::jsonb,
            last_sync_at     = now()
      WHERE voice_call_id = $1
      RETURNING ${CALL_COLS}`,
    [
      existing.voice_call_id,
      nextStatus,
      answered_by,
      Number.isFinite(duration as number) ? duration : null,
      params.ErrorCode || null,
      voicemail,
      JSON.stringify({ last_status_callback: params }),
    ],
  );
  if (!rec) return { matched: false, ignored_reason: 'call disappeared mid-update' };

  await emitEvent({
    event_type: voicemail_detected ? 'twilio-voice.call.voicemail.v1' : 'twilio-voice.call.status.v1',
    pool_index: VOICE_AUDIT_POOL,
    actor_kind: 'service',
    actor_id: 'connector-twilio-voice',
    tenant_id: rec.tenant_id,
    subject_kind: 'connector_twilio_voice.voice_call',
    subject_id: rec.voice_call_id,
    payload: {
      external_id: rec.external_id,
      status: rec.status,
      answered_by: rec.answered_by,
      is_voicemail: rec.is_voicemail,
      duration_seconds: rec.duration_seconds,
    },
  });

  await notifyCallEvent(rec, voicemail_detected ? 'voicemail' : 'status');
  return { matched: true, call: rec, voicemail_detected };
}

/* ---------------------------------------------------------- recording ingest */

export interface RecordingCallbackResult {
  matched: boolean;
  call?: VoiceCallRecord;
  ignored_reason?: string;
}

/**
 * Apply a Twilio recording-status callback (RecordingSid / RecordingUrl /
 * RecordingDuration / CallSid). Idempotent: re-delivery of the same recording
 * overwrites with identical values. An unknown Call SID is acknowledged, not
 * raised.
 */
export async function applyRecordingCallback(params: Record<string, string>): Promise<RecordingCallbackResult> {
  const sid = params.CallSid || params.callSid;
  if (!sid) return { matched: false, ignored_reason: 'no CallSid in payload' };

  const existing = await findCallBySid(sid);
  if (!existing) return { matched: false, ignored_reason: `unknown CallSid ${sid}` };

  const duration = params.RecordingDuration ? Number(params.RecordingDuration) : null;
  const rec = await dataService.one<VoiceCallRecord>(
    `UPDATE connector_twilio_voice.voice_call
        SET recording_url              = COALESCE($2, recording_url),
            recording_sid              = COALESCE($3, recording_sid),
            recording_duration_seconds = COALESCE($4, recording_duration_seconds),
            payload                    = payload || $5::jsonb,
            last_sync_at               = now()
      WHERE voice_call_id = $1
      RETURNING ${CALL_COLS}`,
    [
      existing.voice_call_id,
      params.RecordingUrl || null,
      params.RecordingSid || null,
      Number.isFinite(duration as number) ? duration : null,
      JSON.stringify({ last_recording_callback: params }),
    ],
  );
  if (!rec) return { matched: false, ignored_reason: 'call disappeared mid-update' };

  await emitEvent({
    event_type: 'twilio-voice.call.recording.v1',
    pool_index: VOICE_AUDIT_POOL,
    actor_kind: 'service',
    actor_id: 'connector-twilio-voice',
    tenant_id: rec.tenant_id,
    subject_kind: 'connector_twilio_voice.voice_call',
    subject_id: rec.voice_call_id,
    payload: {
      external_id: rec.external_id,
      recording_sid: rec.recording_sid,
      recording_duration_seconds: rec.recording_duration_seconds,
      is_voicemail: rec.is_voicemail,
    },
  });

  await notifyCallEvent(rec, 'recording');
  return { matched: true, call: rec };
}

/* ------------------------------------------------------------ downstream hook */

export type VoiceCallEventKind = 'status' | 'voicemail' | 'recording';
/**
 * Downstream sink for completed call events. sdk-voice / sdk-crm bridge into
 * this (TK-3654) to log the call or voicemail as CRM activity; default no-op so
 * the connector carries no CRM dependency.
 */
export type VoiceCallEventHandler = (call: VoiceCallRecord, kind: VoiceCallEventKind) => Promise<void>;

let _callEventHandler: VoiceCallEventHandler | null = null;
export function setVoiceCallEventHandler(handler: VoiceCallEventHandler | null): void {
  _callEventHandler = handler;
}

/** Fan out to the downstream handler; never let a sink failure fail the webhook. */
async function notifyCallEvent(call: VoiceCallRecord, kind: VoiceCallEventKind): Promise<void> {
  if (!_callEventHandler) return;
  try {
    await _callEventHandler(call, kind);
  } catch (err) {
    console.warn(`[connector-twilio-voice] call-event handler failed for ${call.external_id}:`, (err as Error).message);
  }
}

/* -------------------------------------------------------------------- helpers */

/**
 * Find a call by its Twilio SID. The mirror's uniqueness is per install, but a
 * Call SID is globally unique upstream, so the newest match is the right row.
 */
async function findCallBySid(sid: string): Promise<VoiceCallRecord | null> {
  return dataService.one<VoiceCallRecord>(
    `SELECT ${CALL_COLS} FROM connector_twilio_voice.voice_call
      WHERE external_id = $1
      ORDER BY started_at DESC
      LIMIT 1`,
    [sid],
  );
}

/** Map Twilio's AnsweredBy onto the DB enum, or null when absent/unrecognised. */
export function normalizeAnsweredBy(value: string | null | undefined): string | null {
  if (!value) return null;
  const v = value.toLowerCase().trim();
  const allowed = ['human', 'machine_start', 'machine_end_beep', 'machine_end_silence', 'machine_end_other', 'fax', 'unknown'];
  if (allowed.includes(v)) return v;
  // Twilio has historically sent a bare 'machine'; treat it as the start marker.
  if (v === 'machine') return 'machine_start';
  return 'unknown';
}
