import { dataService } from '@projexlight/db-runtime';
import { emitEvent } from '@projexlight/sdk-audit';
import {
  ACTIVITY_KINDS,
  CALL_DISPOSITIONS,
  isMissedCall,
  type CallActivityRecord,
  type CallDirection,
  type CallDisposition,
  type LogCallInput,
  type LogVoicemailInput,
} from '../models/crm.model';

/**
 * sdk-crm call/voicemail activity (P15·E5, TK-3656).
 *
 * Logs a call or voicemail onto the contact/lead timeline with its structured
 * telephony fields (direction, disposition, duration, recording + consent,
 * transcript), and emits the matching event — crm.call.missed.v1 when nobody
 * picked up, crm.voicemail.received.v1 for a voicemail, crm.call.logged.v1
 * otherwise.
 *
 * Writes are IDEMPOTENT on external_call_id (migration 005's partial unique
 * index): the telephony connector's webhooks retry, so re-logging the same
 * provider call id updates the existing timeline entry instead of appending a
 * duplicate.
 */

const CRM_AUDIT_POOL = process.env.CRM_AUDIT_POOL || 'admin-default';

const CALL_ACTIVITY_COLS = `
  activity_id, encounter_id, kind, actor_persona_id, summary, occurred_at,
  call_direction, call_disposition, call_duration_seconds, phone_number,
  recording_url, recording_consent, voicemail_transcript, external_call_id`;

const DIRECTIONS: CallDirection[] = ['inbound', 'outbound'];

/** Thrown when a call/voicemail payload violates the enum or numeric contract. */
export class InvalidCallActivity extends Error {
  constructor(public details: string[]) {
    super(`[sdk-crm] invalid call activity: ${details.join('; ')}`);
    this.name = 'InvalidCallActivity';
  }
}

/**
 * Validate the telephony fields against the DB CHECK constraints BEFORE the
 * insert, so a bad enum comes back as a typed 400 rather than a raw Postgres
 * 23514 surfacing as a 500.
 */
function validate(input: {
  kind: string;
  call_direction?: string;
  call_disposition?: string;
  call_duration_seconds?: number | null;
}): void {
  const details: string[] = [];
  if (!ACTIVITY_KINDS.includes(input.kind as never)) {
    details.push(`kind must be one of ${ACTIVITY_KINDS.join('|')}`);
  }
  if (!input.call_direction || !DIRECTIONS.includes(input.call_direction as CallDirection)) {
    details.push(`call_direction must be one of ${DIRECTIONS.join('|')}`);
  }
  if (!input.call_disposition || !CALL_DISPOSITIONS.includes(input.call_disposition as CallDisposition)) {
    details.push(`call_disposition must be one of ${CALL_DISPOSITIONS.join('|')}`);
  }
  if (
    input.call_duration_seconds !== undefined &&
    input.call_duration_seconds !== null &&
    (!Number.isFinite(input.call_duration_seconds) || input.call_duration_seconds < 0)
  ) {
    details.push('call_duration_seconds must be a non-negative number');
  }
  if (details.length) throw new InvalidCallActivity(details);
}

/**
 * Log a call on the timeline.
 *
 * @throws InvalidCallActivity when kind/direction/disposition/duration are invalid.
 */
export async function logCall(input: LogCallInput): Promise<CallActivityRecord> {
  validate({
    kind: 'call',
    call_direction: input.call_direction,
    call_disposition: input.call_disposition,
    call_duration_seconds: input.call_duration_seconds ?? null,
  });
  return insertCallActivity('call', input, null);
}

/**
 * Log a voicemail on the timeline. Disposition defaults to 'voicemail' (the call
 * reached the contact's voicemail); pass 'left_message' when the rep recorded
 * one. Emits crm.voicemail.received.v1.
 *
 * @throws InvalidCallActivity when the fields are invalid.
 */
export async function logVoicemail(input: LogVoicemailInput): Promise<CallActivityRecord> {
  const disposition: CallDisposition = input.call_disposition ?? 'voicemail';
  if (disposition !== 'voicemail' && disposition !== 'left_message') {
    throw new InvalidCallActivity(['voicemail call_disposition must be voicemail or left_message']);
  }
  validate({
    kind: 'voicemail',
    call_direction: input.call_direction,
    call_disposition: disposition,
    call_duration_seconds: input.call_duration_seconds ?? null,
  });
  return insertCallActivity(
    'voicemail',
    { ...input, call_disposition: disposition },
    input.voicemail_transcript ?? null,
  );
}

async function insertCallActivity(
  kind: 'call' | 'voicemail',
  input: LogCallInput,
  transcript: string | null,
): Promise<CallActivityRecord> {
  // ON CONFLICT on the partial unique index makes webhook retries idempotent:
  // the same provider call id updates its existing timeline entry in place.
  // `xmax = 0` is true only for a genuine INSERT; on the ON CONFLICT DO UPDATE
  // path it is the id of the updating transaction. That distinction is what
  // keeps the DOMAIN event idempotent too: a retried webhook must not emit a
  // second call.logged/missed/voicemail for a call already on the timeline, or
  // downstream consumers double-count it.
  const rec = await dataService.one<CallActivityRecord & { was_inserted: boolean }>(
    `INSERT INTO crm.activity
       (encounter_id, kind, actor_persona_id, summary, occurred_at, call_direction,
        call_disposition, call_duration_seconds, phone_number, recording_url,
        recording_consent, voicemail_transcript, external_call_id)
     VALUES ($1, $2, $3, $4, COALESCE($5::timestamptz, now()), $6, $7, $8, $9, $10, $11, $12, $13)
     ON CONFLICT (external_call_id) WHERE external_call_id IS NOT NULL
     DO UPDATE SET
       kind                  = EXCLUDED.kind,
       summary               = COALESCE(EXCLUDED.summary, crm.activity.summary),
       call_disposition      = EXCLUDED.call_disposition,
       call_duration_seconds = COALESCE(EXCLUDED.call_duration_seconds, crm.activity.call_duration_seconds),
       recording_url         = COALESCE(EXCLUDED.recording_url, crm.activity.recording_url),
       recording_consent     = COALESCE(EXCLUDED.recording_consent, crm.activity.recording_consent),
       voicemail_transcript  = COALESCE(EXCLUDED.voicemail_transcript, crm.activity.voicemail_transcript)
     RETURNING ${CALL_ACTIVITY_COLS}, (xmax = 0) AS was_inserted`,
    [
      input.encounter_id,
      kind,
      input.actor_persona_id,
      input.summary ?? null,
      input.occurred_at ?? null,
      input.call_direction,
      input.call_disposition,
      input.call_duration_seconds ?? null,
      input.phone_number ?? null,
      input.recording_url ?? null,
      input.recording_consent ?? null,
      transcript,
      input.external_call_id ?? null,
    ],
  );
  if (!rec) throw new Error('[sdk-crm] call activity insert returned no row');

  const { was_inserted, ...activity } = rec;
  // Idempotent replay: the row is refreshed above, but the event was already
  // emitted the first time this call id was seen.
  if (!was_inserted) return activity;

  // Activity sits inside an encounter — tenant_id comes from there for audit.
  const enc = await dataService.one<{ tenant_id: string }>(
    `SELECT tenant_id FROM engagement.encounter WHERE encounter_id = $1`,
    [input.encounter_id],
  );

  const event_type =
    kind === 'voicemail'
      ? 'crm.voicemail.received.v1'
      : isMissedCall(input.call_disposition)
        ? 'crm.call.missed.v1'
        : 'crm.call.logged.v1';

  await emitEvent({
    event_type,
    pool_index: CRM_AUDIT_POOL,
    actor_kind: 'service',
    actor_id: input.actor_persona_id,
    tenant_id: enc?.tenant_id ?? null,
    subject_kind: 'crm.activity',
    subject_id: rec.activity_id,
    payload: {
      encounter_id: rec.encounter_id,
      kind: rec.kind,
      call_direction: rec.call_direction,
      call_disposition: rec.call_disposition,
      call_duration_seconds: rec.call_duration_seconds,
      external_call_id: rec.external_call_id,
      recording_consent: rec.recording_consent,
      has_recording: !!rec.recording_url,
    },
  });
  return activity;
}

/**
 * Read the call/voicemail timeline for one encounter, newest first, optionally
 * narrowed to a kind or disposition.
 */
export async function listCallActivities(
  encounter_id: string,
  opts: { kind?: string; call_disposition?: string; limit?: number; offset?: number } = {},
): Promise<CallActivityRecord[]> {
  return dataService.rows<CallActivityRecord>(
    `SELECT ${CALL_ACTIVITY_COLS}
       FROM crm.activity
      WHERE encounter_id = $1
        AND kind IN ('call','voicemail')
        AND ($2::text IS NULL OR kind = $2)
        AND ($3::text IS NULL OR call_disposition = $3)
      ORDER BY occurred_at DESC
      LIMIT $4 OFFSET $5`,
    [encounter_id, opts.kind ?? null, opts.call_disposition ?? null, opts.limit ?? 50, opts.offset ?? 0],
  );
}
