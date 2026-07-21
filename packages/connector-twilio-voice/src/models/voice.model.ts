/**
 * connector-twilio-voice domain model (P15·E4). Mirrors the migration-001 CHECK
 * constraints, which are authoritative.
 */

export type CallDirection = 'inbound' | 'outbound';

/** Twilio call status vocabulary (note Twilio's single-l 'canceled'). */
export type CallStatus =
  | 'queued'
  | 'initiated'
  | 'ringing'
  | 'in-progress'
  | 'completed'
  | 'busy'
  | 'no-answer'
  | 'canceled'
  | 'failed';

export const CALL_STATUSES: CallStatus[] = [
  'queued', 'initiated', 'ringing', 'in-progress',
  'completed', 'busy', 'no-answer', 'canceled', 'failed',
];

/** Twilio AnsweredBy (answering-machine detection) outcome. */
export type AnsweredBy =
  | 'human'
  | 'machine_start'
  | 'machine_end_beep'
  | 'machine_end_silence'
  | 'machine_end_other'
  | 'fax'
  | 'unknown';

export const ANSWERED_BY_VALUES: AnsweredBy[] = [
  'human', 'machine_start', 'machine_end_beep',
  'machine_end_silence', 'machine_end_other', 'fax', 'unknown',
];

/**
 * AMD outcomes that mean the call reached a machine rather than a person.
 * 'unknown' and 'fax' are deliberately NOT voicemail: unknown means detection
 * was inconclusive, and treating it as voicemail would log phantom voicemails.
 */
export const VOICEMAIL_ANSWERED_BY: AnsweredBy[] = [
  'machine_start', 'machine_end_beep', 'machine_end_silence', 'machine_end_other',
];

export function isVoicemailOutcome(answered_by: string | null | undefined): boolean {
  return !!answered_by && (VOICEMAIL_ANSWERED_BY as string[]).includes(answered_by);
}

export type TrackingNumberStatus = 'active' | 'released' | 'deleted-upstream';

export interface TrackingNumberRecord {
  tracking_number_id: string;
  install_id: string;
  tenant_id: string;
  external_id: string;
  phone_number: string;
  friendly_name: string | null;
  capabilities: Record<string, unknown>;
  purpose: string | null;
  assigned_persona_id: string | null;
  status: TrackingNumberStatus;
  provisioned_at: string;
  released_at: string | null;
  payload: Record<string, unknown>;
  last_sync_at: string;
}

export interface VoiceCallRecord {
  voice_call_id: string;
  install_id: string;
  tenant_id: string;
  external_id: string;
  direction: CallDirection;
  from_number: string;
  to_number: string;
  tracking_number_id: string | null;
  subject_persona_id: string | null;
  initiated_by_persona_id: string | null;
  status: CallStatus;
  answered_by: AnsweredBy | null;
  duration_seconds: number | null;
  recording_url: string | null;
  recording_sid: string | null;
  recording_duration_seconds: number | null;
  is_voicemail: boolean;
  voicemail_transcript: string | null;
  error_code: string | null;
  payload: Record<string, unknown>;
  started_at: string;
  answered_at: string | null;
  ended_at: string | null;
  last_sync_at: string;
}

export interface ProvisionNumberInput {
  install_id: string;
  tenant_id: string;
  phone_number: string;
  friendly_name?: string | null;
  purpose?: string | null;
  assigned_persona_id?: string | null;
  area_code?: string | null;
}

export interface PlaceCallInput {
  install_id: string;
  tenant_id: string;
  to_number: string;
  from_number?: string | null;
  tracking_number_id?: string | null;
  subject_persona_id?: string | null;
  initiated_by_persona_id?: string | null;
  /** Record the call leg. Defaults to true — the SOP wants call recordings. */
  record?: boolean;
  /** Enable answering-machine detection so voicemail can be classified. */
  machine_detection?: boolean;
  metadata?: Record<string, unknown>;
}
