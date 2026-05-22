import { getProvider } from '../providers/kmsProvider';
import { findRef, markRotated, registerRef, type SecretRef, type SecretScope } from './secretRefCatalog';
import type { KmsProviderKind } from '../providers/kmsProvider';

export interface RegisterSecretInput {
  ref: string;
  scope: SecretScope;
  kms_key_id: string;
  provider?: KmsProviderKind;
}

/**
 * Registers a new SecretRef in the catalog and returns the persisted record.
 * The catalog itself is held in process memory per P1-Foundation-Spine §5.1
 * (no Postgres rows for sdk-secrets).
 */
export async function storeSecret(input: RegisterSecretInput): Promise<SecretRef> {
  try {
    const now = new Date().toISOString();
    return registerRef({
      ref: input.ref,
      scope: input.scope,
      provider: input.provider ?? getProvider().kind,
      kms_key_id: input.kms_key_id,
      created_at: now,
      rotated_at: null,
    });
  } catch (err) {
    throw err;
  }
}

/**
 * Looks up a SecretRef by ref string. Used by both the GET endpoint and by
 * other SDKs resolving secret:// references at runtime.
 */
export async function retrieveSecret(ref: string): Promise<SecretRef | null> {
  try {
    return findRef(ref);
  } catch (err) {
    throw err;
  }
}

export interface RotateResult {
  ref: SecretRef;
  new_key_version: string;
}

/**
 * Rotates the underlying KMS key version, then updates rotated_at on the
 * SecretRef. Emits secrets.key.rotated.v1 (caller wires the event bus).
 */
export async function rotateSecret(ref: string): Promise<RotateResult> {
  try {
    const meta = findRef(ref);
    if (!meta) {
      throw new Error(`Secret reference not registered: ${ref}`);
    }
    const result = await getProvider().rotateKey(meta.kms_key_id);
    const updated = markRotated(ref);
    return { ref: updated, new_key_version: result.new_key_version };
  } catch (err) {
    throw err;
  }
}
