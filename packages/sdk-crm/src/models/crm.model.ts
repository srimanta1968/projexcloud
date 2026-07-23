export type LifecycleStage = 'lead' | 'prospect' | 'customer' | 'churned' | 'former';
export type DealStage = 'qualifying' | 'proposal' | 'negotiation' | 'closed-won' | 'closed-lost';
// 'voicemail' added in migration 003 (P15·E5) — the DB CHECK is authoritative.
export type ActivityKind = 'call' | 'email' | 'meeting' | 'note' | 'task' | 'voicemail';

export const ACTIVITY_KINDS: ActivityKind[] = ['call', 'email', 'meeting', 'note', 'task', 'voicemail'];

export type CallDirection = 'inbound' | 'outbound';

/** Call outcome vocabulary (migration 003 CHECK on crm.activity.call_disposition). */
export type CallDisposition =
  | 'answered'
  | 'no_answer'
  | 'busy'
  | 'failed'
  | 'voicemail'
  | 'left_message';

export const CALL_DISPOSITIONS: CallDisposition[] = [
  'answered', 'no_answer', 'busy', 'failed', 'voicemail', 'left_message',
];

/**
 * Dispositions that mean nobody picked up — these emit crm.call.missed.v1.
 * 'voicemail' and 'left_message' are NOT here: reaching voicemail is its own
 * outcome (crm.voicemail.received.v1) rather than a plain missed call, and
 * conflating them would double-count the same call in follow-up reporting.
 */
export const MISSED_DISPOSITIONS: CallDisposition[] = ['no_answer', 'busy', 'failed'];

export function isMissedCall(disposition: CallDisposition): boolean {
  return MISSED_DISPOSITIONS.includes(disposition);
}
export type LeadStatus = 'new' | 'qualified' | 'unqualified' | 'converted';

export interface ContactRecord {
  contact_id: string;
  tenant_id: string;
  persona_id: string;
  lifecycle_stage: LifecycleStage;
  source: string | null;
  owner_persona_id: string | null;
  custom_fields: Record<string, unknown>;
  external_refs: Record<string, string>;
  created_at: Date;
  updated_at: Date;
}

export interface DealRecord {
  deal_id: string;
  tenant_id: string;
  encounter_id: string;
  contact_id: string | null;
  name: string;
  amount: number | null;
  currency: string | null;
  stage: DealStage;
  close_probability: number | null;
  custom_fields: Record<string, unknown>;
  external_refs: Record<string, string>;
  created_at: Date;
  updated_at: Date;
}

export interface ActivityRecord {
  activity_id: string;
  encounter_id: string;
  kind: ActivityKind;
  actor_persona_id: string;
  summary: string | null;
  occurred_at: Date;
}

/**
 * An activity row with the structured telephony columns added in migration 003.
 * Returned by logCall / logVoicemail; the plain ActivityRecord shape is kept for
 * the generic logActivity path so existing callers are unaffected.
 */
export interface CallActivityRecord extends ActivityRecord {
  call_direction: CallDirection | null;
  call_disposition: CallDisposition | null;
  call_duration_seconds: number | null;
  phone_number: string | null;
  recording_url: string | null;
  recording_consent: boolean | null;
  voicemail_transcript: string | null;
  external_call_id: string | null;
}

export interface LogCallInput {
  encounter_id: string;
  actor_persona_id: string;
  call_direction: CallDirection;
  call_disposition: CallDisposition;
  call_duration_seconds?: number | null;
  phone_number?: string | null;
  recording_url?: string | null;
  recording_consent?: boolean | null;
  external_call_id?: string | null;
  summary?: string | null;
  occurred_at?: string | null;
}

export interface LogVoicemailInput extends Omit<LogCallInput, 'call_disposition'> {
  /** Defaults to 'voicemail'; 'left_message' when the rep left one. */
  call_disposition?: Extract<CallDisposition, 'voicemail' | 'left_message'>;
  voicemail_transcript?: string | null;
}

export interface LeadRecord {
  lead_id: string;
  tenant_id: string;
  source: string;
  contact_id: string | null;
  status: LeadStatus;
  score: number | null;
  custom_fields: Record<string, unknown>;
  external_refs: Record<string, string>;
  created_at: Date;
}

export interface CreateContactInput {
  tenant_id: string;
  persona_id: string;
  lifecycle_stage?: LifecycleStage;
  source?: string;
  owner_persona_id?: string;
  custom_fields?: Record<string, unknown>;
  external_refs?: Record<string, string>;
}

export interface UpdateContactInput {
  lifecycle_stage?: LifecycleStage;
  owner_persona_id?: string;
  custom_fields?: Record<string, unknown>;
  external_refs?: Record<string, string>;
}

export interface CreateDealInput {
  tenant_id: string;
  encounter_id: string;
  contact_id?: string;
  name: string;
  amount?: number;
  currency?: string;
  close_probability?: number;
  custom_fields?: Record<string, unknown>;
  external_refs?: Record<string, string>;
}

export interface LogActivityInput {
  encounter_id: string;
  kind: ActivityKind;
  actor_persona_id: string;
  summary?: string;
  occurred_at?: string;
}
