import type { Obligations } from '@projexlight/contracts';
import type { CreatePolicyInput, EvaluatePolicyInput } from '../models/policy.model';

export type ValidationResult<T> = { ok: true; value: T } | { ok: false; errors: string[] };

const AUDIT_LEVELS = ['none', 'standard', 'detailed', 'forensic'] as const;

/**
 * Validates an optional obligations object on policy create. Returns the
 * normalized obligations (or undefined) and pushes any shape errors.
 */
function parseObligations(raw: unknown, errors: string[]): Obligations | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== 'object') {
    errors.push('obligations must be an object');
    return undefined;
  }
  const o = raw as Record<string, unknown>;
  const result: Obligations = {};
  if (o.mask_fields !== undefined) {
    if (!Array.isArray(o.mask_fields) || o.mask_fields.some((f) => typeof f !== 'string')) {
      errors.push('obligations.mask_fields must be an array of strings');
    } else {
      result.mask_fields = o.mask_fields as string[];
    }
  }
  if (o.row_filter !== undefined) {
    if (typeof o.row_filter !== 'object' || Array.isArray(o.row_filter)) {
      errors.push('obligations.row_filter must be an object');
    } else {
      result.row_filter = o.row_filter as Record<string, unknown>;
    }
  }
  if (o.audit_level !== undefined) {
    if (!AUDIT_LEVELS.includes(o.audit_level as (typeof AUDIT_LEVELS)[number])) {
      errors.push(`obligations.audit_level must be one of ${AUDIT_LEVELS.join(', ')}`);
    } else {
      result.audit_level = o.audit_level as Obligations['audit_level'];
    }
  }
  if (o.ttl_seconds !== undefined) {
    if (typeof o.ttl_seconds !== 'number' || o.ttl_seconds < 0) {
      errors.push('obligations.ttl_seconds must be a non-negative number');
    } else {
      result.ttl_seconds = o.ttl_seconds;
    }
  }
  return result;
}

function asString(v: unknown): string {
  return typeof v === 'string' ? v.trim() : '';
}

export function validateCreatePolicy(body: unknown): ValidationResult<CreatePolicyInput> {
  if (!body || typeof body !== 'object') return { ok: false, errors: ['body must be an object'] };
  const b = body as Record<string, unknown>;
  const errors: string[] = [];

  const name = asString(b.name);
  const iql_source = asString(b.iql_source);
  const version = asString(b.version);
  const tenant_id = typeof b.tenant_id === 'string' ? b.tenant_id : undefined;

  if (!name) errors.push('name is required');
  if (!iql_source) errors.push('iql_source is required');
  if (!version) errors.push('version is required');

  const obligations = parseObligations(b.obligations, errors);

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, value: { name, iql_source, version, tenant_id, ...(obligations ? { obligations } : {}) } };
}

export function validateEvaluatePolicy(body: unknown): ValidationResult<EvaluatePolicyInput> {
  if (!body || typeof body !== 'object') return { ok: false, errors: ['body must be an object'] };
  const b = body as Record<string, unknown>;
  const errors: string[] = [];

  const policy_id = asString(b.policy_id);
  const subject_id = asString(b.subject_id);
  const target_id = typeof b.target_id === 'string' ? b.target_id : undefined;
  const context = (b.context && typeof b.context === 'object')
    ? (b.context as Record<string, unknown>)
    : {};

  if (!policy_id) errors.push('policy_id is required');
  if (!subject_id) errors.push('subject_id is required');

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, value: { policy_id, subject_id, target_id, context } };
}
