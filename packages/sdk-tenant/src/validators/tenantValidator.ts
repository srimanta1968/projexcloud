import type {
  CreateTenantInput,
  FiscalPeriodKind,
  GeoKind,
  IsolationTier,
  InvoiceAggregation,
  ResidencyClass,
} from '../models/tenant.model';
import type {
  AttachResellerTerms,
  CreateBuInput,
  CreateGeoNodeInput,
  CreateResellerInput,
  CreateRoleTemplateInput,
  SetFiscalCalendarInput,
  SubTenantPlacement,
} from '../services/tenantService';

export type ValidationResult<T> = { ok: true; value: T } | { ok: false; errors: string[] };

const VALID_TIERS: IsolationTier[] = ['S', 'P', 'G'];
const VALID_GEO_KINDS: GeoKind[] = ['region', 'country', 'state', 'city', 'locality'];
const VALID_RESIDENCY: ResidencyClass[] = ['open', 'regulated', 'sovereign'];
const VALID_INVOICE: InvoiceAggregation[] = ['per-tenant', 'consolidated'];
const VALID_PLACEMENT: ('share' | 'tier-p' | 'tier-g')[] = ['share', 'tier-p', 'tier-g'];
const VALID_PERIOD_KIND: FiscalPeriodKind[] = ['year', 'quarter', 'month', 'week'];

function asString(v: unknown): string { return typeof v === 'string' ? v.trim() : ''; }

export function validateCreateTenant(body: unknown): ValidationResult<CreateTenantInput> {
  const errors: string[] = [];
  if (!body || typeof body !== 'object') return { ok: false, errors: ['body must be an object'] };
  const b = body as Record<string, unknown>;

  const app_id = asString(b.app_id);
  const display_name = asString(b.display_name);
  const region = asString(b.region);

  if (!app_id) errors.push('app_id is required');
  if (!display_name) errors.push('display_name is required');
  if (!region) errors.push('region is required');

  const isolation_tier = typeof b.isolation_tier === 'string' ? (b.isolation_tier as IsolationTier) : undefined;
  if (isolation_tier && !VALID_TIERS.includes(isolation_tier)) {
    errors.push(`isolation_tier must be one of ${VALID_TIERS.join(', ')}`);
  }

  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    value: {
      app_id, display_name, region, isolation_tier,
      parent_tenant_id: typeof b.parent_tenant_id === 'string' ? b.parent_tenant_id : undefined,
      reseller_id: typeof b.reseller_id === 'string' ? b.reseller_id : undefined,
      geo_node_id: typeof b.geo_node_id === 'string' ? b.geo_node_id : undefined,
      brand_domain: typeof b.brand_domain === 'string' ? b.brand_domain : undefined,
      admin_pool_index: typeof b.admin_pool_index === 'string' ? b.admin_pool_index : undefined,
      app_pool_index: (b.app_pool_index && typeof b.app_pool_index === 'object')
        ? (b.app_pool_index as Record<string, string>)
        : undefined,
      module_subscriptions: Array.isArray(b.module_subscriptions)
        ? (b.module_subscriptions as string[])
        : undefined,
    },
  };
}

export function validateCreateReseller(body: unknown): ValidationResult<CreateResellerInput> {
  if (!body || typeof body !== 'object') return { ok: false, errors: ['body must be an object'] };
  const b = body as Record<string, unknown>;
  const errors: string[] = [];

  const org_id = asString(b.org_id);
  const brand_name = asString(b.brand_name);
  const invoice_aggregation = typeof b.invoice_aggregation === 'string'
    ? (b.invoice_aggregation as InvoiceAggregation)
    : undefined;

  if (!org_id) errors.push('org_id is required');
  if (!brand_name) errors.push('brand_name is required');
  if (invoice_aggregation && !VALID_INVOICE.includes(invoice_aggregation)) {
    errors.push(`invoice_aggregation must be one of ${VALID_INVOICE.join(', ')}`);
  }

  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    value: {
      org_id, brand_name, invoice_aggregation,
      cname_host: typeof b.cname_host === 'string' ? b.cname_host : undefined,
      support_contact: (b.support_contact && typeof b.support_contact === 'object')
        ? (b.support_contact as Record<string, unknown>) : undefined,
      commission_rules: (b.commission_rules && typeof b.commission_rules === 'object')
        ? (b.commission_rules as Record<string, unknown>) : undefined,
    },
  };
}

export function validateAttachReseller(body: unknown): ValidationResult<{
  reseller_id: string;
  commission_rules?: Record<string, unknown>;
}> {
  if (!body || typeof body !== 'object') return { ok: false, errors: ['body must be an object'] };
  const b = body as Record<string, unknown>;
  const errors: string[] = [];
  const reseller_id = asString(b.reseller_id);
  if (!reseller_id) errors.push('reseller_id is required');
  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    value: {
      reseller_id,
      commission_rules: (b.commission_rules && typeof b.commission_rules === 'object')
        ? (b.commission_rules as Record<string, unknown>) : undefined,
    },
  };
}

export function validateCreateSubTenant(
  body: unknown,
): ValidationResult<Omit<CreateTenantInput, 'parent_tenant_id'> & SubTenantPlacement> {
  if (!body || typeof body !== 'object') return { ok: false, errors: ['body must be an object'] };
  const b = body as Record<string, unknown>;
  const errors: string[] = [];

  const app_id = asString(b.app_id);
  const display_name = asString(b.display_name);
  const region = asString(b.region);
  const placement = typeof b.placement === 'string' ? (b.placement as 'share' | 'tier-p' | 'tier-g') : undefined;

  if (!app_id) errors.push('app_id is required');
  if (!display_name) errors.push('display_name is required');
  if (!region) errors.push('region is required');
  if (placement && !VALID_PLACEMENT.includes(placement)) {
    errors.push(`placement must be one of ${VALID_PLACEMENT.join(', ')}`);
  }

  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    value: {
      app_id, display_name, region, placement,
      reseller_id: typeof b.reseller_id === 'string' ? b.reseller_id : undefined,
      isolation_tier: typeof b.isolation_tier === 'string' ? (b.isolation_tier as IsolationTier) : undefined,
      geo_node_id: typeof b.geo_node_id === 'string' ? b.geo_node_id : undefined,
      brand_domain: typeof b.brand_domain === 'string' ? b.brand_domain : undefined,
    },
  };
}

export function validateCreateBu(body: unknown): ValidationResult<CreateBuInput> {
  if (!body || typeof body !== 'object') return { ok: false, errors: ['body must be an object'] };
  const b = body as Record<string, unknown>;
  const errors: string[] = [];
  const name = asString(b.name);
  const kind = asString(b.kind);
  if (!name) errors.push('name is required');
  if (!kind) errors.push('kind is required');
  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    value: {
      name, kind,
      parent_bu_id: typeof b.parent_bu_id === 'string' ? b.parent_bu_id : undefined,
    },
  };
}

export function validateCreateGeoNode(body: unknown): ValidationResult<CreateGeoNodeInput> {
  if (!body || typeof body !== 'object') return { ok: false, errors: ['body must be an object'] };
  const b = body as Record<string, unknown>;
  const errors: string[] = [];
  const name = asString(b.name);
  const kind = asString(b.kind) as GeoKind;
  const residency_class = typeof b.residency_class === 'string'
    ? (b.residency_class as ResidencyClass) : undefined;
  if (!name) errors.push('name is required');
  if (!VALID_GEO_KINDS.includes(kind)) errors.push(`kind must be one of ${VALID_GEO_KINDS.join(', ')}`);
  if (residency_class && !VALID_RESIDENCY.includes(residency_class)) {
    errors.push(`residency_class must be one of ${VALID_RESIDENCY.join(', ')}`);
  }
  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    value: {
      name, kind, residency_class,
      parent_geo_node_id: typeof b.parent_geo_node_id === 'string' ? b.parent_geo_node_id : undefined,
      code: typeof b.code === 'string' ? b.code : undefined,
    },
  };
}

export function validateCreateRoleTemplate(body: unknown): ValidationResult<CreateRoleTemplateInput> {
  if (!body || typeof body !== 'object') return { ok: false, errors: ['body must be an object'] };
  const b = body as Record<string, unknown>;
  const errors: string[] = [];
  const app_id = asString(b.app_id);
  const name = asString(b.name);
  if (!app_id) errors.push('app_id is required');
  if (!name) errors.push('name is required');
  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    value: {
      app_id, name,
      tenant_id: typeof b.tenant_id === 'string' ? b.tenant_id : undefined,
      parent_role_template_id: typeof b.parent_role_template_id === 'string'
        ? b.parent_role_template_id : undefined,
      permissions: (b.permissions && typeof b.permissions === 'object')
        ? (b.permissions as Record<string, unknown>) : undefined,
    },
  };
}

export function validateSetFiscalCalendar(body: unknown): ValidationResult<SetFiscalCalendarInput> {
  if (!body || typeof body !== 'object') return { ok: false, errors: ['body must be an object'] };
  const b = body as Record<string, unknown>;
  const errors: string[] = [];

  const year_start_month = typeof b.year_start_month === 'number' ? b.year_start_month : NaN;
  const base_currency = asString(b.base_currency);
  const period_kind = typeof b.period_kind === 'string'
    ? (b.period_kind as FiscalPeriodKind) : undefined;

  if (!Number.isFinite(year_start_month) || year_start_month < 1 || year_start_month > 12) {
    errors.push('year_start_month must be an integer 1..12');
  }
  if (!base_currency || base_currency.length !== 3) errors.push('base_currency must be an ISO-4217 3-letter code');
  if (period_kind && !VALID_PERIOD_KIND.includes(period_kind)) {
    errors.push(`period_kind must be one of ${VALID_PERIOD_KIND.join(', ')}`);
  }
  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, value: { year_start_month, base_currency, period_kind } };
}
