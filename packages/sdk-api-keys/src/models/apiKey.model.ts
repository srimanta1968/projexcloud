/**
 * TypeScript models mirroring api_keys.key and api_keys.application per P2 §11.
 */

export type ApiKeyStatus = 'active' | 'rotating' | 'revoked' | 'expired';
export type HashAlg = 'pbkdf2-sha256-310000' | 'argon2id' | 'hmac-sha256';
/** live/test belongs to the APPLICATION; a key inherits it and cannot disagree. */
export type Environment = 'live' | 'test';
export type ApplicationStatus = 'active' | 'disabled';

export interface ApplicationRecord {
  application_id: string;
  tenant_id: string;
  name: string;
  /** Stable, tenant-unique identifier a customer puts in their config as client_id. */
  slug: string;
  description: string | null;
  environment: Environment;
  status: ApplicationStatus;
  owner_persona_id: string | null;
  created_by_persona_id: string | null;
  created_at: Date;
  disabled_at: Date | null;
}

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
  /** NULL for system credentials (sdk-command per-robot keys) that belong to an asset, not an application. */
  application_id: string | null;
  name: string | null;
  environment: Environment | null;
  created_by_persona_id: string | null;
}

export interface CreateApplicationInput {
  tenant_id: string;
  name: string;
  slug?: string;
  description?: string;
  environment?: Environment;
  owner_persona_id?: string;
  created_by_persona_id?: string;
}

export interface IssueApiKeyInput {
  tenant_id: string;
  scopes: string[];
  rate_limit_rpm?: number;
  expires_at?: string;
  /** Omitted only for system credentials; a tenant-facing key always names one. */
  application_id?: string;
  name?: string;
  /** Overrides the application's environment only when there is no application. */
  environment?: Environment;
  created_by_persona_id?: string;
}

export interface IssueApiKeyResult {
  key: ApiKeyRecord;
  /** Plaintext key, returned only at issuance and rotation (never persisted). */
  plaintext: string;
}

/** Columns every read of api_keys.key returns. Never includes key_hash or key_lookup. */
export const KEY_COLUMNS = `key_id, tenant_id, prefix, hash_alg, synthetic_persona_id,
            scopes, rate_limit_rpm, expires_at, status,
            last_used_at, created_at, rotated_from_key_id, revoked_at,
            application_id, name, environment, created_by_persona_id`;

export const APPLICATION_COLUMNS = `application_id, tenant_id, name, slug, description,
            environment, status, owner_persona_id, created_by_persona_id,
            created_at, disabled_at`;
