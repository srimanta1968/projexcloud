/**
 * Models mirroring profile.* tables per P3-Canonical-Privacy-HDK-DataModel §4.1.
 */

export type BandKind = 'profile' | 'preference' | 'notification_routing';
export type ShredReason = 'retention-expiry' | 'dsar-erasure' | 'operator-request';

export interface BandL2Record {
  band_id: string;
  app_identity_id: string;
  band_kind: BandKind;
  tenant_id: string;
  fields_envelope: Record<string, string>;
  updated_at: Date;
}

export interface SecureDataRecord {
  person_id: string;
  field_envelopes: Record<string, string>;
  field_states: Record<string, { state: 'active' | 'shredded'; shredded_at?: string }>;
  updated_at: Date;
}

export interface FieldShredLogRecord {
  shred_id: string;
  person_id: string;
  field_name: string;
  reason: ShredReason;
  audit_entry_id: string | null;
  occurred_at: Date;
}

export interface UpsertBandInput {
  app_identity_id: string;
  band_kind: BandKind;
  tenant_id: string;
  fields_envelope: Record<string, string>;
}

export interface SetSecureFieldInput {
  person_id: string;
  field_name: string;
  envelope: string;
}

export interface ShredSecureFieldInput {
  person_id: string;
  field_name: string;
  reason: ShredReason;
  audit_entry_id?: string;
}
