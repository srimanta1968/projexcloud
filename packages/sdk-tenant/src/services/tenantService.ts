import { dataService } from '@projexlight/db-runtime';
import { emitEvent } from '@projexlight/sdk-audit';
import type {
  BuRecord,
  CreateTenantInput,
  FiscalPeriodKind,
  FiscalPeriodRecord,
  GeoNodeRecord,
  RoleTemplateRecord,
  ResellerRecord,
  TenantRecord,
} from '../models/tenant.model';

/**
 * sdk-tenant service layer per P2 §5.1 / FR-TNT-1..10.
 * All writes route through @projexlight/db-runtime (OC-3).
 */

export async function createTenant(input: CreateTenantInput): Promise<TenantRecord> {
  const rows = await dataService.rows<TenantRecord>(
    `INSERT INTO tenant.tenant (
       app_id, display_name, region, parent_tenant_id, reseller_id,
       isolation_tier, geo_node_id, brand_domain,
       admin_pool_index, app_pool_index, module_subscriptions
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11)
     RETURNING tenant_id, app_id, parent_tenant_id, root_tenant_id, reseller_id,
               isolation_tier, region, geo_node_id, brand_domain,
               admin_pool_index, app_pool_index, module_subscriptions,
               status, display_name, created_at, updated_at`,
    [
      input.app_id,
      input.display_name,
      input.region,
      input.parent_tenant_id ?? null,
      input.reseller_id ?? null,
      input.isolation_tier ?? 'S',
      input.geo_node_id ?? null,
      input.brand_domain ?? null,
      input.admin_pool_index ?? null,
      JSON.stringify(input.app_pool_index ?? {}),
      input.module_subscriptions ?? [],
    ],
  );
  const tenant = rows[0];
  // FR-TNT-9 + audit fan-out
  await emitEvent({
    event_type: 'tenant.created.v1',
    payload: {
      tenant_id: tenant.tenant_id,
      app_id: tenant.app_id,
      parent_tenant_id: tenant.parent_tenant_id,
      isolation_tier: tenant.isolation_tier,
      region: tenant.region,
    },
    pool_index: tenant.admin_pool_index ?? 'admin',
    actor_kind: 'service',
    actor_id: 'sdk-tenant.create',
    tenant_id: tenant.tenant_id,
    app_id: tenant.app_id,
    subject_kind: 'tenant',
    subject_id: tenant.tenant_id,
  });
  await emitEvent({
    event_type: 'tenant.pool.assigned.v1',
    payload: {
      tenant_id: tenant.tenant_id,
      admin_pool_index: tenant.admin_pool_index,
      app_pool_index: tenant.app_pool_index,
    },
    pool_index: tenant.admin_pool_index ?? 'admin',
    actor_kind: 'service',
    actor_id: 'sdk-tenant.create',
    tenant_id: tenant.tenant_id,
    subject_kind: 'tenant',
    subject_id: tenant.tenant_id,
  });
  if (tenant.parent_tenant_id) {
    await emitEvent({
      event_type: 'tenant.subtenant.created.v1',
      payload: { tenant_id: tenant.tenant_id, parent_tenant_id: tenant.parent_tenant_id },
      pool_index: tenant.admin_pool_index ?? 'admin',
      actor_kind: 'service',
      actor_id: 'sdk-tenant.create',
      tenant_id: tenant.parent_tenant_id,
      subject_kind: 'tenant',
      subject_id: tenant.tenant_id,
    });
  }
  return tenant;
}

export async function listTenants(limit = 200): Promise<TenantRecord[]> {
  return dataService.rows<TenantRecord>(
    `SELECT tenant_id, app_id, parent_tenant_id, root_tenant_id, reseller_id,
            isolation_tier, region, geo_node_id, brand_domain,
            admin_pool_index, app_pool_index, module_subscriptions,
            status, display_name, created_at, updated_at
       FROM tenant.tenant
       ORDER BY created_at DESC
       LIMIT $1`,
    [limit],
  );
}

export async function getTenant(tenant_id: string): Promise<TenantRecord | null> {
  return dataService.one<TenantRecord>(
    `SELECT tenant_id, app_id, parent_tenant_id, root_tenant_id, reseller_id,
            isolation_tier, region, geo_node_id, brand_domain,
            admin_pool_index, app_pool_index, module_subscriptions,
            status, display_name, created_at, updated_at
       FROM tenant.tenant WHERE tenant_id = $1`,
    [tenant_id],
  );
}

/* ---------------------------------------------------------------- reseller */

export interface CreateResellerInput {
  org_id: string;
  brand_name: string;
  cname_host?: string;
  support_contact?: Record<string, unknown>;
  commission_rules?: Record<string, unknown>;
  invoice_aggregation?: 'per-tenant' | 'consolidated';
}

export async function createReseller(input: CreateResellerInput): Promise<ResellerRecord> {
  const rows = await dataService.rows<ResellerRecord>(
    `INSERT INTO tenant.reseller (
       org_id, brand_name, cname_host, support_contact, commission_rules, invoice_aggregation
     ) VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, $6)
     RETURNING reseller_id, org_id, brand_name, cname_host,
               support_contact, commission_rules, invoice_aggregation,
               portfolio_kill_switch, created_at`,
    [
      input.org_id,
      input.brand_name,
      input.cname_host ?? null,
      JSON.stringify(input.support_contact ?? {}),
      JSON.stringify(input.commission_rules ?? {}),
      input.invoice_aggregation ?? 'per-tenant',
    ],
  );
  const reseller = rows[0];
  await emitEvent({
    event_type: 'reseller.created.v1',
    payload: {
      reseller_id: reseller.reseller_id,
      org_id: reseller.org_id,
      brand_name: reseller.brand_name,
    },
    pool_index: 'admin',
    actor_kind: 'service',
    actor_id: 'sdk-tenant.createReseller',
    org_id: reseller.org_id,
    subject_kind: 'reseller',
    subject_id: reseller.reseller_id,
  });
  return reseller;
}

/**
 * FR-TNT-3: recursive CTE walker for audit roll-up. Returns the parent
 * chain ordered immediate-parent → root.
 */
export async function getTenantAncestorChain(tenant_id: string): Promise<TenantRecord[]> {
  return dataService.rows<TenantRecord>(
    `WITH RECURSIVE chain AS (
       SELECT * FROM tenant.tenant WHERE tenant_id = $1
       UNION ALL
       SELECT t.* FROM tenant.tenant t JOIN chain c ON t.tenant_id = c.parent_tenant_id
     )
     SELECT * FROM chain WHERE tenant_id <> $1 ORDER BY tenant_id`,
    [tenant_id],
  );
}

export interface AttachResellerTerms {
  commission_rules?: Record<string, unknown>;
}

export async function attachReseller(
  tenant_id: string,
  reseller_id: string,
  terms: AttachResellerTerms,
): Promise<TenantRecord> {
  if (terms.commission_rules) {
    await dataService.query(
      `UPDATE tenant.reseller SET commission_rules = $1::jsonb WHERE reseller_id = $2`,
      [JSON.stringify(terms.commission_rules), reseller_id],
    );
  }
  const rows = await dataService.rows<TenantRecord>(
    `UPDATE tenant.tenant SET reseller_id = $1, updated_at = now()
      WHERE tenant_id = $2
      RETURNING tenant_id, app_id, parent_tenant_id, root_tenant_id, reseller_id,
                isolation_tier, region, geo_node_id, brand_domain,
                admin_pool_index, app_pool_index, module_subscriptions,
                status, display_name, created_at, updated_at`,
    [reseller_id, tenant_id],
  );
  if (rows.length === 0) throw new Error(`Tenant ${tenant_id} not found`);
  const tenant = rows[0];
  await emitEvent({
    event_type: 'reseller.tenant.attached.v1',
    payload: { tenant_id, reseller_id, commission_rules: terms.commission_rules ?? null },
    pool_index: tenant.admin_pool_index ?? 'admin',
    actor_kind: 'service',
    actor_id: 'sdk-tenant.attachReseller',
    tenant_id,
    subject_kind: 'tenant',
    subject_id: tenant_id,
  });
  return tenant;
}

/* ---------------------------------------------------------------- sub-tenant */

export interface SubTenantPlacement {
  placement?: 'share' | 'tier-p' | 'tier-g';
}

export async function createSubTenant(
  parent_tenant_id: string,
  input: Omit<CreateTenantInput, 'parent_tenant_id'>,
  placement: SubTenantPlacement = {},
): Promise<TenantRecord> {
  const parent = await getTenant(parent_tenant_id);
  if (!parent) throw new Error(`Parent tenant ${parent_tenant_id} not found`);

  const place = placement.placement ?? 'share';
  const isolation_tier =
    place === 'tier-p' ? 'P' : place === 'tier-g' ? 'G' : input.isolation_tier ?? parent.isolation_tier;
  const admin_pool_index =
    place === 'share' ? parent.admin_pool_index : input.admin_pool_index ?? null;
  const app_pool_index =
    place === 'share' ? parent.app_pool_index : input.app_pool_index ?? {};

  return createTenant({
    ...input,
    parent_tenant_id,
    region: input.region || parent.region,
    isolation_tier,
    admin_pool_index,
    app_pool_index,
  });
}

/* ------------------------------------------------------------------- BU */

export interface CreateBuInput {
  parent_bu_id?: string;
  name: string;
  kind: string;
}

export async function createBu(tenant_id: string, input: CreateBuInput): Promise<BuRecord> {
  let ancestors: string[] = [];
  if (input.parent_bu_id) {
    const parent = await dataService.one<{ ancestors: string[]; name: string }>(
      `SELECT ancestors, name FROM tenant.bu WHERE bu_id = $1 AND tenant_id = $2`,
      [input.parent_bu_id, tenant_id],
    );
    if (!parent) throw new Error(`Parent BU ${input.parent_bu_id} not found in tenant`);
    ancestors = [...parent.ancestors, parent.name];
  }
  const rows = await dataService.rows<BuRecord>(
    `INSERT INTO tenant.bu (tenant_id, parent_bu_id, name, kind, ancestors)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING bu_id, tenant_id, parent_bu_id, name, kind, ancestors, created_at`,
    [tenant_id, input.parent_bu_id ?? null, input.name, input.kind, ancestors],
  );
  return rows[0];
}

/* --------------------------------------------------------------- geo node */

export interface CreateGeoNodeInput {
  parent_geo_node_id?: string;
  kind: 'region' | 'country' | 'state' | 'city' | 'locality';
  code?: string;
  name: string;
  residency_class?: 'open' | 'regulated' | 'sovereign';
}

export async function createGeoNode(input: CreateGeoNodeInput): Promise<GeoNodeRecord> {
  const rows = await dataService.rows<GeoNodeRecord>(
    `INSERT INTO tenant.geo_node (parent_geo_node_id, kind, code, name, residency_class)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING geo_node_id, parent_geo_node_id, kind, code, name, residency_class`,
    [
      input.parent_geo_node_id ?? null,
      input.kind,
      input.code ?? null,
      input.name,
      input.residency_class ?? 'open',
    ],
  );
  return rows[0];
}

/* ------------------------------------------------------------ role template */

export interface CreateRoleTemplateInput {
  tenant_id?: string;
  app_id: string;
  name: string;
  parent_role_template_id?: string;
  permissions?: Record<string, unknown>;
}

export async function createRoleTemplate(input: CreateRoleTemplateInput): Promise<RoleTemplateRecord> {
  const rows = await dataService.rows<RoleTemplateRecord>(
    `INSERT INTO tenant.role_template (tenant_id, app_id, name, parent_role_template_id, permissions)
     VALUES ($1, $2, $3, $4, $5::jsonb)
     RETURNING role_template_id, tenant_id, app_id, name, parent_role_template_id, permissions`,
    [
      input.tenant_id ?? null,
      input.app_id,
      input.name,
      input.parent_role_template_id ?? null,
      JSON.stringify(input.permissions ?? {}),
    ],
  );
  return rows[0];
}

/* --------------------------------------------------------- fiscal calendar */

export interface SetFiscalCalendarInput {
  year_start_month: number;
  base_currency: string;
  period_kind?: FiscalPeriodKind;
}

export async function setFiscalCalendar(
  tenant_id: string,
  input: SetFiscalCalendarInput,
): Promise<FiscalPeriodRecord[]> {
  const startMonth = input.year_start_month;
  if (startMonth < 1 || startMonth > 12) throw new Error('year_start_month must be 1..12');

  await dataService.query(`DELETE FROM tenant.fiscal_period WHERE tenant_id = $1`, [tenant_id]);

  const now = new Date();
  const baseYear = now.getMonth() + 1 >= startMonth ? now.getFullYear() : now.getFullYear() - 1;
  const inserts: Array<Promise<FiscalPeriodRecord>> = [];
  for (const offset of [0, 1]) {
    const fyStart = new Date(Date.UTC(baseYear + offset, startMonth - 1, 1));
    const fyEnd = new Date(Date.UTC(baseYear + offset + 1, startMonth - 1, 0));
    inserts.push(
      insertFiscalRow(tenant_id, input, 'year', `FY${baseYear + offset}`, fyStart, fyEnd),
    );
    for (let q = 0; q < 4; q++) {
      const qStart = new Date(Date.UTC(baseYear + offset, startMonth - 1 + q * 3, 1));
      const qEnd = new Date(Date.UTC(baseYear + offset, startMonth - 1 + q * 3 + 3, 0));
      inserts.push(
        insertFiscalRow(
          tenant_id, input, 'quarter',
          `FY${baseYear + offset}-Q${q + 1}`, qStart, qEnd,
        ),
      );
    }
  }
  return Promise.all(inserts);
}

async function insertFiscalRow(
  tenant_id: string,
  input: SetFiscalCalendarInput,
  kind: FiscalPeriodKind,
  label: string,
  starts_at: Date,
  ends_at: Date,
): Promise<FiscalPeriodRecord> {
  const rows = await dataService.rows<FiscalPeriodRecord>(
    `INSERT INTO tenant.fiscal_period
       (tenant_id, year_start_month, base_currency, period_kind, label, starts_at, ends_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING fiscal_period_id, tenant_id, year_start_month, base_currency,
                 period_kind, label, starts_at, ends_at`,
    [
      tenant_id,
      input.year_start_month,
      input.base_currency.toUpperCase(),
      kind,
      label,
      starts_at.toISOString().slice(0, 10),
      ends_at.toISOString().slice(0, 10),
    ],
  );
  return rows[0];
}
