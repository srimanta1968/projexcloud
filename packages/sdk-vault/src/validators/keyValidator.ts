import { KEY_TIERS, type KeyTier } from '../models/keyHierarchy.model';

export interface IssueKeyBody {
  tier: KeyTier;
  scope_id?: string;
  parent_key_id?: string;
  kms_ref: string;
  algorithm?: 'AES-256-GCM' | 'ChaCha20-Poly1305';
  tenant_id?: string;
  region: string;
}

export type ValidationResult<T> =
  | { ok: true; value: T }
  | { ok: false; errors: string[] };

/**
 * Validates POST /api/vault/keys payload. Tier must be in canonical list;
 * non-root keys require parent_key_id (enforced again by the DB trigger).
 */
export function validateIssueKey(body: unknown): ValidationResult<IssueKeyBody> {
  const errors: string[] = [];
  if (!body || typeof body !== 'object') return { ok: false, errors: ['body must be an object'] };
  const b = body as Record<string, unknown>;

  const tier = typeof b.tier === 'string' ? (b.tier as KeyTier) : undefined;
  if (!tier) errors.push('tier is required');
  else if (!KEY_TIERS.includes(tier)) errors.push(`tier must be one of ${KEY_TIERS.join(', ')}`);

  const kms_ref = typeof b.kms_ref === 'string' ? b.kms_ref.trim() : '';
  if (!kms_ref) errors.push('kms_ref is required');

  const region = typeof b.region === 'string' ? b.region.trim() : '';
  if (!region) errors.push('region is required');

  if (tier && tier !== 'root' && typeof b.parent_key_id !== 'string') {
    errors.push('parent_key_id is required for non-root tiers');
  }

  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    value: {
      tier: tier!,
      kms_ref,
      region,
      scope_id: typeof b.scope_id === 'string' ? b.scope_id : undefined,
      parent_key_id: typeof b.parent_key_id === 'string' ? b.parent_key_id : undefined,
      tenant_id: typeof b.tenant_id === 'string' ? b.tenant_id : undefined,
      algorithm: b.algorithm === 'ChaCha20-Poly1305' ? 'ChaCha20-Poly1305' : 'AES-256-GCM',
    },
  };
}

export interface EnvelopeEncryptBody {
  ref: string;
  plaintext_b64: string;
}

export function validateEnvelopeEncrypt(body: unknown): ValidationResult<EnvelopeEncryptBody> {
  const errors: string[] = [];
  if (!body || typeof body !== 'object') return { ok: false, errors: ['body must be an object'] };
  const b = body as Record<string, unknown>;
  const ref = typeof b.ref === 'string' ? b.ref.trim() : '';
  const plaintext_b64 = typeof b.plaintext_b64 === 'string' ? b.plaintext_b64 : '';
  if (!ref) errors.push('ref is required');
  if (!plaintext_b64) errors.push('plaintext_b64 is required');
  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, value: { ref, plaintext_b64 } };
}

export interface EnvelopeDecryptBody {
  ref: string;
  ciphertext_b64: string;
  wrapped_dek_b64: string;
  iv_b64: string;
  tag_b64: string;
}

export function validateEnvelopeDecrypt(body: unknown): ValidationResult<EnvelopeDecryptBody> {
  const errors: string[] = [];
  if (!body || typeof body !== 'object') return { ok: false, errors: ['body must be an object'] };
  const b = body as Record<string, unknown>;
  const required: (keyof EnvelopeDecryptBody)[] = ['ref', 'ciphertext_b64', 'wrapped_dek_b64', 'iv_b64', 'tag_b64'];
  for (const k of required) {
    if (typeof b[k] !== 'string' || (b[k] as string).length === 0) errors.push(`${k} is required`);
  }
  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    value: {
      ref: (b.ref as string).trim(),
      ciphertext_b64: b.ciphertext_b64 as string,
      wrapped_dek_b64: b.wrapped_dek_b64 as string,
      iv_b64: b.iv_b64 as string,
      tag_b64: b.tag_b64 as string,
    },
  };
}
