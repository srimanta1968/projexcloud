/**
 * Six identity types per FR-CTR-3 + P2/P5 data models.
 * Concrete tables land in:
 *   P2 · identity.app_identity, identity.tenant_membership, identity.persona
 *   P5 · engagement.encounter, engagement.relationship, engagement.relationship_grant
 * In P1 these are reserved names so consumers can import the types without a
 * circular-dependency rewrite when the tables ship.
 */

export interface AppIdentity {
  app_identity_id: string;
  person_id: string;
  app_id: string;
  external_subject: string | null;
  created_at: string;
}

export interface TenantMembership {
  membership_id: string;
  person_id: string;
  tenant_id: string;
  bu_id: string | null;
  role_template_id: string | null;
  status: 'active' | 'suspended' | 'offboarded';
  created_at: string;
}

export interface Persona {
  persona_id: string;
  person_id: string;
  tenant_id: string;
  persona_kind: string;
  display_name: string;
  attributes: Record<string, unknown>;
}

export interface Encounter {
  encounter_id: string;
  persona_id: string;
  tenant_id: string;
  encounter_kind: string;
  opened_at: string;
  sealed_at: string | null;
}

export interface Relationship {
  relationship_id: string;
  subject_persona_id: string;
  object_persona_id: string;
  relation: string;
  tenant_id: string;
}

export interface RelationshipGrant {
  grant_id: string;
  relationship_id: string;
  capability: string;
  granted_at: string;
  expires_at: string | null;
}

// ---- Existing P1 request/response shapes ---------------------------------

export interface RegisterRequest {
  email: string;
  password: string;
}

export interface RegisterResponse {
  userId: string;
  email: string;
  token: string;
}

export interface JwtClaims {
  sub: string;
  email: string;
}
