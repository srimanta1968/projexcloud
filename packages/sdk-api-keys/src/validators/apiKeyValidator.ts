import type { IssueApiKeyInput } from '../models/apiKey.model';

export type ValidationResult<T> = { ok: true; value: T } | { ok: false; errors: string[] };

function asString(v: unknown): string { return typeof v === 'string' ? v.trim() : ''; }

export function validateIssueKey(body: unknown): ValidationResult<IssueApiKeyInput> {
  if (!body || typeof body !== 'object') return { ok: false, errors: ['body must be an object'] };
  const b = body as Record<string, unknown>;
  const errors: string[] = [];

  const tenant_id = asString(b.tenant_id);
  const scopes = Array.isArray(b.scopes) && b.scopes.every((s) => typeof s === 'string')
    ? (b.scopes as string[])
    : null;
  const rate_limit_rpm = typeof b.rate_limit_rpm === 'number' ? b.rate_limit_rpm : undefined;
  const expires_at = typeof b.expires_at === 'string' ? b.expires_at : undefined;

  if (!tenant_id) errors.push('tenant_id is required');
  if (!scopes || scopes.length === 0) errors.push('scopes must be a non-empty string array');
  if (rate_limit_rpm !== undefined && (!Number.isFinite(rate_limit_rpm) || rate_limit_rpm <= 0)) {
    errors.push('rate_limit_rpm must be a positive number');
  }
  if (expires_at && Number.isNaN(Date.parse(expires_at))) errors.push('expires_at must be ISO-8601');
  // An expiry already in the past would mint a credential that is dead on
  // arrival — accepted by the schema, refused by the very next request, and
  // debugged as "the key does not work" rather than "the key expired".
  if (expires_at && !Number.isNaN(Date.parse(expires_at)) && Date.parse(expires_at) <= Date.now()) {
    errors.push('expires_at must be in the future');
  }

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, value: { tenant_id, scopes: scopes!, rate_limit_rpm, expires_at } };
}
