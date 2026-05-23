import type { CreatePolicyInput, EvaluatePolicyInput } from '../models/policy.model';

export type ValidationResult<T> = { ok: true; value: T } | { ok: false; errors: string[] };

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

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, value: { name, iql_source, version, tenant_id } };
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
