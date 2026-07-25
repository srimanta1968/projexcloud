import { apiGet, apiPost } from '../lib/apiClient';

/**
 * Thin client wrapper over the sdk-config gateway routes (EP-341) for the
 * tenant-workspace portal. All calls are JWT-authenticated by apiClient; for the
 * `app` / `app_user` scopes the gateway derives scope_id (app_id / the caller's
 * sub) from the JWT, so callers pass only {scope, key, value|secret_ref}.
 */

export type ConfigScope = 'platform' | 'tenant' | 'app' | 'app_user';

/** A stored config row as returned by GET /api/config (config.config_value). */
export interface ConfigRow {
  config_id: string;
  scope: ConfigScope;
  scope_id: string;
  key: string;
  value: Record<string, unknown> | null;
  secret_ref: string | null;
  status: string;
  set_by: string | null;
  created_at: string;
  updated_at: string;
}

/** List the active config rows for a scope (scope_id derived server-side). */
export async function listConfig(scope: ConfigScope): Promise<ConfigRow[]> {
  return apiGet<ConfigRow[]>(`/api/config?scope=${encodeURIComponent(scope)}`);
}

export interface SetConfigInput {
  scope: ConfigScope;
  key: string;
  /** Non-secret JSON value. Mutually exclusive with secret_ref. */
  value?: Record<string, unknown>;
  /** sdk-secrets envelope pointer for a secret value. */
  secret_ref?: string;
}

/** Upsert a config value (non-secret `value` or secret `secret_ref`). */
export async function setConfig(input: SetConfigInput): Promise<ConfigRow> {
  return apiPost<ConfigRow>('/api/config', input);
}

/** Revoke (soft-delete) a config value for a scope/key. */
export async function revokeConfig(scope: ConfigScope, key: string): Promise<ConfigRow> {
  return apiPost<ConfigRow>('/api/config/revoke', { scope, key });
}
