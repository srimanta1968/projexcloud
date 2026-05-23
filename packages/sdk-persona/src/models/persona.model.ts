/**
 * Models mirroring persona.* tables per P3-Canonical-Privacy-HDK-DataModel §5.1.
 */

export type AppIdentityStatus = 'active' | 'suspended' | 'merged_into' | 'erased';
export type MembershipStatus = 'active' | 'suspended' | 'terminated';
export type PersonaStatus = 'active' | 'suspended' | 'shredded';

export interface AppIdentityRecord {
  app_identity_id: string;
  person_id: string;
  app_id: string;
  status: AppIdentityStatus;
  merged_into_app_identity_id: string | null;
  created_at: Date;
}

export interface MembershipRecord {
  membership_id: string;
  app_identity_id: string;
  tenant_id: string;
  status: MembershipStatus;
  joined_at: Date;
  terminated_at: Date | null;
}

export interface PersonaRecord {
  persona_id: string;
  membership_id: string;
  kind: string;
  primary_role_template_id: string | null;
  bu_id: string | null;
  persona_key_ref: string | null;
  status: PersonaStatus;
  created_at: Date;
  shredded_at: Date | null;
}

export interface RoleAssignmentRecord {
  assignment_id: string;
  persona_id: string;
  role_template_id: string;
  assigned_at: Date;
  revoked_at: Date | null;
  assigned_by: string | null;
}

export interface CreateAppIdentityInput {
  person_id: string;
  app_id: string;
}

export interface CreateMembershipInput {
  app_identity_id: string;
  tenant_id: string;
}

export interface CreatePersonaInput {
  membership_id: string;
  kind: string;
  primary_role_template_id?: string;
  bu_id?: string;
  persona_key_ref?: string;
}

export interface AssignRoleInput {
  persona_id: string;
  role_template_id: string;
  assigned_by?: string;
}
