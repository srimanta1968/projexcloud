export { migrationsDir } from './db';
export * as server from './server';
export {
  setConfig,
  getConfig,
  listConfig,
  revokeConfig,
  rotateConfigSecret,
  type SetConfigInput,
} from './services/configStore';
export {
  resolveConfig,
  resolveConfigValue,
  invalidateConfig,
  clearConfigCache,
} from './services/resolveConfig';
export { importEnvDefaults } from './services/envDefaults';
export {
  checkProviderConfigured,
  providerNotConfiguredBody,
  type ProviderNotConfigured,
} from './services/providerGuard';

/**
 * The precedence tiers of the config plane. resolveConfig walks these from most
 * specific to least specific (app_user -> app -> tenant -> platform) and the
 * first active match wins.
 */
export type ConfigScope = 'platform' | 'tenant' | 'app' | 'app_user';

/** Scope order from MOST specific to LEAST specific — the resolution walk. */
export const SCOPE_PRECEDENCE: ConfigScope[] = ['app_user', 'app', 'tenant', 'platform'];

export type ConfigStatus = 'active' | 'revoked';

/** A stored config row (config.config_value). Secret values keep only secret_ref. */
export interface ConfigValueRef {
  config_id: string;
  scope: ConfigScope;
  scope_id: string;
  key: string;
  value: Record<string, unknown> | null;
  secret_ref: string | null;
  status: ConfigStatus;
  set_by: string | null;
  created_at: string;
  updated_at: string;
}

/**
 * The context resolveConfig resolves against. Any subset may be present; the
 * resolver only consults the scopes it has an id for (plus platform, always).
 */
export interface ConfigContext {
  tenant_id?: string | null;
  app_id?: string | null;
  app_user_id?: string | null;
}
