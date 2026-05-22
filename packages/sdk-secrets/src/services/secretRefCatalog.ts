import type { KmsProviderKind } from '../providers/kmsProvider';

export type SecretScope = 'app' | 'pool' | 'tenant';

export interface SecretRef {
  ref: string;
  scope: SecretScope;
  provider: KmsProviderKind;
  kms_key_id: string;
  created_at: string;
  rotated_at: string | null;
}

const REF_RE = /^secret:\/\/(app|pool|tenant)\/[a-zA-Z0-9._-]+$/;

const catalog: Map<string, SecretRef> = new Map();

/**
 * Parses and validates a secret:// reference string. Returns scope + id.
 */
export function parseRef(ref: string): { scope: SecretScope; id: string } {
  if (!REF_RE.test(ref)) {
    throw new Error(`Invalid secret reference: ${ref} (expected secret://{scope}/{id})`);
  }
  const [, scope, id] = ref.match(/^secret:\/\/(app|pool|tenant)\/(.+)$/)!;
  return { scope: scope as SecretScope, id };
}

/**
 * Registers a SecretRef. Idempotent on (ref) — overwrites the existing entry.
 */
export function registerRef(ref: SecretRef): SecretRef {
  parseRef(ref.ref);
  catalog.set(ref.ref, ref);
  return ref;
}

/** Looks up a SecretRef by its ref string. Returns null if not registered. */
export function findRef(ref: string): SecretRef | null {
  return catalog.get(ref) ?? null;
}

/** Marks a SecretRef rotated; sets rotated_at to now(). */
export function markRotated(ref: string): SecretRef {
  const existing = catalog.get(ref);
  if (!existing) {
    throw new Error(`Secret reference not registered: ${ref}`);
  }
  const updated: SecretRef = { ...existing, rotated_at: new Date().toISOString() };
  catalog.set(ref, updated);
  return updated;
}

/** Lists all currently registered refs (for the diagnostic endpoint). */
export function listRefs(): SecretRef[] {
  return Array.from(catalog.values());
}
