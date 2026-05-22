/**
 * sdk-vault TypeScript model mirroring vault.key per P1-Foundation-Spine §6.
 * Seven envelope tiers: root > app > pool > tenant > person > device > encounter.
 */

export const KEY_TIERS = ['root', 'app', 'pool', 'tenant', 'person', 'device', 'encounter'] as const;
export type KeyTier = typeof KEY_TIERS[number];

export type KeyState = 'issued' | 'active' | 'rotated' | 'shredded';
export type KeyAlgorithm = 'AES-256-GCM' | 'ChaCha20-Poly1305';

export interface KeyRecord {
  key_id: string;
  tier: KeyTier;
  scope_id: string | null;
  parent_key_id: string | null;
  kms_ref: string | null;
  state: KeyState;
  algorithm: KeyAlgorithm;
  issued_at: Date;
  rotated_at: Date | null;
  shredded_at: Date | null;
  tenant_id: string | null;
  region: string;
}

export interface CreateKeyInput {
  tier: KeyTier;
  scope_id?: string | null;
  parent_key_id?: string | null;
  kms_ref?: string;
  algorithm?: KeyAlgorithm;
  tenant_id?: string | null;
  region: string;
}

export type KeyOperationKind = 'issue' | 'rotate' | 'shred' | 'decrypt' | 'encrypt';
export type OperatorKind = 'human' | 'service' | 'agent';

export interface KeyOperationRecord {
  op_id: string;
  key_id: string;
  op: KeyOperationKind;
  operator_kind: OperatorKind;
  operator_id: string;
  occurred_at: Date;
  audit_entry_id: string | null;
  reason: string | null;
}

export interface EncounterKeySealRecord {
  encounter_id: string;
  encounter_key_id: string;
  opened_at: Date;
  sealed_at: Date | null;
  retention_policy: string;
  tenant_id: string;
}

const TIER_RANK: Record<KeyTier, number> = {
  root: 0,
  app: 1,
  pool: 2,
  tenant: 3,
  person: 4,
  device: 5,
  encounter: 6,
};

/**
 * Returns true when `parent` is a valid wrapping tier for `child` — parent must
 * be strictly higher (lower rank) in the hierarchy. Root takes no parent.
 */
export function isValidParentTier(child: KeyTier, parent: KeyTier | null): boolean {
  if (child === 'root') return parent === null;
  if (parent === null) return false;
  return TIER_RANK[parent] < TIER_RANK[child];
}
