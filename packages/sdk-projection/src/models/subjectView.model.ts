/**
 * TypeScript model mirroring projection.subject_view per P2 §10.
 * Used by sdk-policy precomp cache, by services/identity-projector writer,
 * and by sdk-identity-resolver (P3) for hot reads.
 */
export interface SubjectViewRecord {
  person_id: string;
  app_id: string;
  tenant_id: string;
  bu_id: string | null;
  primary_persona_id: string | null;
  all_persona_ids: string[];
  role_template_id: string | null;
  effective_role_closure: string[];
  reachable_personas: string[];
  consents_granted: string[];
  admin_pool_index: string | null;
  app_pool_index: string | null;
  projection_version: number;
  refreshed_at: Date;
}

export interface ProjectSubjectInput {
  person_id: string;
  app_id: string;
  tenant_id: string;
  bu_id?: string;
  primary_persona_id?: string;
  all_persona_ids?: string[];
  role_template_id?: string;
  effective_role_closure?: string[];
  reachable_personas?: string[];
  consents_granted?: string[];
  admin_pool_index?: string;
  app_pool_index?: string;
}

export const PROJECTION_REFRESH_CHANNEL = 'identity:projection:refreshed';
export const PROJECTION_INVALIDATE_CHANNEL = 'identity:projection:invalidate';

export interface ProjectionRefreshedMessage {
  person_id: string;
  app_id: string;
  tenant_id: string;
  projection_version: number;
}
