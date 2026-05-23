/**
 * IdentityContext + AttributeProvenance per P3 PRD §5.3 / FR-IDR-1..8.
 *
 * IdentityContext is the frozen object that every downstream SDK consumes.
 * It is composed from JWT claims + the P2 projection subject_view; services
 * MUST NOT walk the six layers by hand (lint rule OC-4).
 */

export interface ConsentReceipt {
  purpose_id: string;
  granted_at?: string;
  expires_at?: string;
}

export interface RebacEdge {
  kind: string;
  other_persona_id: string;
}

export interface IdentityContext {
  person_id: string;
  app_id: string;
  tenant_id: string;
  bu_id?: string;
  bu_ancestors: string[];
  parent_tenant_id?: string;
  root_tenant_id: string;
  reseller_id?: string;
  geo_node_id?: string;
  primary_persona_id?: string;
  all_persona_ids: string[];
  effective_role_closure: string[];
  abac_attributes: Record<string, unknown>;
  rebac_edges: Record<string, RebacEdge[]>;
  active_consents: Record<string, ConsentReceipt>;
  effective_scopes: string[];
  admin_pool_index?: string;
  app_pool_index?: string;
  projection_version: number;
  resolved_at: string;
  source: 'redis-hot' | 'postgres-cold' | 'live-fallback';
}

export interface AttributeProvenance {
  attribute: string;
  source_sdk: string;
  source_event_id?: string;
  computed_at: string;
  projection_version: number;
}

export interface ResolveOptions {
  /**
   * If true, bypass cache and force live composition. Used by the debug
   * surface to surface stale-projection bugs.
   */
  bypass_cache?: boolean;
}
