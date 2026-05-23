import type {
  GenerateInvoiceInput,
  LiveMeterInput,
  RepriceDryRunInput,
  ShowbackInput,
} from '../models/billing.model';

export type ValidationResult<T> = { ok: true; value: T } | { ok: false; errors: string[] };

const UUID_RX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE_RX = /^\d{4}-\d{2}-\d{2}$/;

function asString(v: unknown): string { return typeof v === 'string' ? v.trim() : ''; }

export function validateGenerateInvoice(body: unknown): ValidationResult<GenerateInvoiceInput> {
  if (!body || typeof body !== 'object') return { ok: false, errors: ['body must be an object'] };
  const b = body as Record<string, unknown>;
  const errors: string[] = [];

  const tenant_id = asString(b.tenant_id);
  const catalog_id = asString(b.catalog_id);
  const period_start = asString(b.period_start);
  const period_end = asString(b.period_end);

  if (!UUID_RX.test(tenant_id)) errors.push('tenant_id must be a UUID');
  if (!catalog_id) errors.push('catalog_id is required');
  if (!DATE_RX.test(period_start)) errors.push('period_start must be YYYY-MM-DD');
  if (!DATE_RX.test(period_end)) errors.push('period_end must be YYYY-MM-DD');
  if (period_start && period_end && period_start > period_end) {
    errors.push('period_start must be <= period_end');
  }

  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    value: {
      tenant_id,
      catalog_id,
      period_start,
      period_end,
      currency: typeof b.currency === 'string' ? b.currency : undefined,
      tax_rate: typeof b.tax_rate === 'number' ? b.tax_rate : undefined,
      usage: Array.isArray(b.usage) ? (b.usage as GenerateInvoiceInput['usage']) : undefined,
    },
  };
}

export function validateLiveMeter(query: unknown): ValidationResult<LiveMeterInput> {
  if (!query || typeof query !== 'object') return { ok: false, errors: ['query required'] };
  const q = query as Record<string, unknown>;
  const tenant_id = asString(q.tenant_id);
  if (!UUID_RX.test(tenant_id)) return { ok: false, errors: ['tenant_id must be a UUID'] };
  return { ok: true, value: { tenant_id } };
}

export function validateRepriceDryRun(body: unknown): ValidationResult<RepriceDryRunInput> {
  if (!body || typeof body !== 'object') return { ok: false, errors: ['body must be an object'] };
  const b = body as Record<string, unknown>;
  const errors: string[] = [];

  const tenant_id = asString(b.tenant_id);
  const period_start = asString(b.period_start);
  const period_end = asString(b.period_end);
  const baseline_catalog_id = asString(b.baseline_catalog_id);
  const target_catalog_id = asString(b.target_catalog_id);

  if (!UUID_RX.test(tenant_id)) errors.push('tenant_id must be a UUID');
  if (!DATE_RX.test(period_start)) errors.push('period_start must be YYYY-MM-DD');
  if (!DATE_RX.test(period_end)) errors.push('period_end must be YYYY-MM-DD');
  if (!baseline_catalog_id) errors.push('baseline_catalog_id is required');
  if (!target_catalog_id) errors.push('target_catalog_id is required');

  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    value: {
      tenant_id,
      period_start,
      period_end,
      baseline_catalog_id,
      target_catalog_id,
      usage: Array.isArray(b.usage) ? (b.usage as RepriceDryRunInput['usage']) : undefined,
    },
  };
}

export function validateShowback(query: unknown): ValidationResult<ShowbackInput> {
  if (!query || typeof query !== 'object') return { ok: false, errors: ['query required'] };
  const q = query as Record<string, unknown>;
  const errors: string[] = [];

  const tenant_id = asString(q.tenant_id);
  const period_start = asString(q.period_start);
  const period_end = asString(q.period_end);
  const groupByRaw = q.group_by;

  if (!UUID_RX.test(tenant_id)) errors.push('tenant_id must be a UUID');
  if (!DATE_RX.test(period_start)) errors.push('period_start must be YYYY-MM-DD');
  if (!DATE_RX.test(period_end)) errors.push('period_end must be YYYY-MM-DD');

  const group_by: ShowbackInput['group_by'] = Array.isArray(groupByRaw)
    ? (groupByRaw as string[]).filter((s): s is ShowbackInput['group_by'][number] =>
        ['app_id','bu_id','persona_kind','encounter_id','sku','actor_kind'].includes(s))
    : (typeof groupByRaw === 'string' && groupByRaw.length > 0)
      ? (groupByRaw.split(',').map((s) => s.trim())
          .filter((s): s is ShowbackInput['group_by'][number] =>
            ['app_id','bu_id','persona_kind','encounter_id','sku','actor_kind'].includes(s)))
      : ['sku'];

  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    value: { tenant_id, period_start, period_end, group_by },
  };
}
