/**
 * TypeScript model mirroring api_keys.key per P2 §11.
 */

export type ApiKeyStatus = 'active' | 'rotating' | 'revoked' | 'expired';
export type HashAlg = 'pbkdf2-sha256-310000' | 'argon2id';

export interface ApiKeyRecord {
  key_id: string;
  tenant_id: string;
  prefix: string;
  hash_alg: HashAlg;
  synthetic_persona_id: string;
  scopes: string[];
  rate_limit_rpm: number | null;
  expires_at: Date | null;
  status: ApiKeyStatus;
  last_used_at: Date | null;
  created_at: Date;
  rotated_from_key_id: string | null;
  revoked_at: Date | null;
}

export interface IssueApiKeyInput {
  tenant_id: string;
  scopes: string[];
  rate_limit_rpm?: number;
  expires_at?: string;
}

export interface IssueApiKeyResult {
  key: ApiKeyRecord;
  /** Plaintext key, returned only at issuance and rotation (never persisted). */
  plaintext: string;
}
