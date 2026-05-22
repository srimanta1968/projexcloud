import type { SecretScope } from '../services/secretRefCatalog';

export interface RegisterBody {
  ref: string;
  scope: SecretScope;
  kms_key_id: string;
}

export type ValidationResult<T> = { ok: true; value: T } | { ok: false; errors: string[] };

const VALID_SCOPES: SecretScope[] = ['app', 'pool', 'tenant'];

export function validateRegisterInput(body: unknown): ValidationResult<RegisterBody> {
  const errors: string[] = [];
  if (!body || typeof body !== 'object') {
    return { ok: false, errors: ['body must be an object'] };
  }
  const b = body as Record<string, unknown>;
  const ref = typeof b.ref === 'string' ? b.ref.trim() : '';
  const scope = typeof b.scope === 'string' ? (b.scope as SecretScope) : undefined;
  const kms_key_id = typeof b.kms_key_id === 'string' ? b.kms_key_id.trim() : '';

  if (!ref) errors.push('ref is required');
  if (!scope) errors.push('scope is required');
  else if (!VALID_SCOPES.includes(scope)) errors.push(`scope must be one of ${VALID_SCOPES.join(', ')}`);
  if (!kms_key_id) errors.push('kms_key_id is required');

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, value: { ref, scope: scope!, kms_key_id } };
}
