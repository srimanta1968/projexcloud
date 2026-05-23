/**
 * Models mirroring engagement.* per P5 DataModel §4.1.
 */

export type EncounterState = 'open' | 'in-progress' | 'closed' | 'sealed';

export interface EncounterRecord {
  encounter_id: string;
  tenant_id: string;
  kind: string;
  state: EncounterState;
  vault_key_ref: string | null;
  opened_at: Date;
  closed_at: Date | null;
  sealed_at: Date | null;
  retention_policy: string;
  retention_expires_at: Date | null;
  parent_encounter_id: string | null;
  address_id: string | null;
  billing_ref: string | null;
}

export interface ParticipantRecord {
  participant_id: string;
  encounter_id: string;
  persona_id: string;
  role: string;
  joined_at: Date;
  left_at: Date | null;
  required: boolean;
}

export interface GrantRecord {
  grant_id: string;
  encounter_id: string;
  grantee_persona_id: string;
  issuer_persona_id: string;
  scope: Record<string, unknown>;
  issued_at: Date;
  expires_at: Date;
  revoked_at: Date | null;
  capability_token_ref: string | null;
}

export interface OpenEncounterInput {
  tenant_id: string;
  kind: string;
  retention_policy?: string;
  parent_encounter_id?: string;
  address_id?: string;
  billing_ref?: string;
  /** App pool key to use as parent for the per-encounter Vault key issuance. */
  parent_key_id: string;
  region: string;
}

export interface AddParticipantInput {
  encounter_id: string;
  persona_id: string;
  role: string;
  required?: boolean;
}

export interface IssueGrantInput {
  encounter_id: string;
  grantee_persona_id: string;
  issuer_persona_id: string;
  scope: Record<string, unknown>;
  ttl_ms: number;
  capability_token_ref?: string;
}
