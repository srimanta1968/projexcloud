/**
 * TypeScript model mirroring tenant.* tables per P2-Identity-Access §4.
 */

export type IsolationTier = 'S' | 'P' | 'G';
export type TenantStatus =
  | 'provisioned' | 'trial' | 'active' | 'suspended' | 'offboarding' | 'offboarded';
export type AppStatus = 'active' | 'sunset' | 'retired';
export type GeoKind = 'region' | 'country' | 'state' | 'city' | 'locality';
export type ResidencyClass = 'open' | 'regulated' | 'sovereign';
export type InvoiceAggregation = 'per-tenant' | 'consolidated';
export type FiscalPeriodKind = 'year' | 'quarter' | 'month' | 'week';

export interface OrgRecord {
  org_id: string;
  parent_org_id: string | null;
  name: string;
  created_at: Date;
}

export interface AppRecord {
  app_id: string;
  org_id: string;
  display_name: string;
  status: AppStatus;
  created_at: Date;
}

export interface ResellerRecord {
  reseller_id: string;
  org_id: string;
  brand_name: string;
  cname_host: string | null;
  support_contact: Record<string, unknown>;
  commission_rules: Record<string, unknown>;
  invoice_aggregation: InvoiceAggregation;
  portfolio_kill_switch: boolean;
  created_at: Date;
}

export interface GeoNodeRecord {
  geo_node_id: string;
  parent_geo_node_id: string | null;
  kind: GeoKind;
  code: string | null;
  name: string;
  residency_class: ResidencyClass;
}

export interface TenantRecord {
  tenant_id: string;
  app_id: string;
  parent_tenant_id: string | null;
  root_tenant_id: string;
  reseller_id: string | null;
  isolation_tier: IsolationTier;
  region: string;
  geo_node_id: string | null;
  brand_domain: string | null;
  admin_pool_index: string | null;
  app_pool_index: Record<string, string>;
  module_subscriptions: string[];
  status: TenantStatus;
  display_name: string;
  created_at: Date;
  updated_at: Date;
}

export interface BuRecord {
  bu_id: string;
  tenant_id: string;
  parent_bu_id: string | null;
  name: string;
  kind: string;
  ancestors: string[];
  created_at: Date;
}

export interface RoleTemplateRecord {
  role_template_id: string;
  tenant_id: string | null;
  app_id: string;
  name: string;
  parent_role_template_id: string | null;
  permissions: Record<string, unknown>;
}

export interface FiscalPeriodRecord {
  fiscal_period_id: string;
  tenant_id: string;
  year_start_month: number;
  base_currency: string;
  period_kind: FiscalPeriodKind;
  label: string;
  starts_at: Date;
  ends_at: Date;
}

export interface CreateTenantInput {
  app_id: string;
  display_name: string;
  region: string;
  parent_tenant_id?: string | null;
  reseller_id?: string | null;
  isolation_tier?: IsolationTier;
  geo_node_id?: string | null;
  brand_domain?: string | null;
  admin_pool_index?: string | null;
  app_pool_index?: Record<string, string>;
  module_subscriptions?: string[];
}
