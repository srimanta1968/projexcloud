import { resolveConfig } from './resolveConfig';
import type { ConfigContext } from '../index';

/**
 * PROVIDER_NOT_CONFIGURED (EP-341, HTTP 503) — the standard, debuggable response
 * a runtime handler returns when the provider it needs (LLM key, email/SMS
 * provider, payment provider, …) is configured NOWHERE in the caller's scope
 * chain. It replaces the old opaque 500s and silent dev stubs: the body names
 * the exact config key and the scopes that were checked, so a user knows what to
 * set (via POST /api/config or their Settings page) and a developer can debug at
 * a glance.
 */
export interface ProviderNotConfigured {
  error: 'PROVIDER_NOT_CONFIGURED';
  provider_key: string;
  message: string;
  scopes_checked: string[];
}

function scopesChecked(ctx: ConfigContext): string[] {
  const scopes: string[] = [];
  if (ctx.app_user_id) scopes.push('app_user');
  if (ctx.app_id) scopes.push('app');
  if (ctx.tenant_id) scopes.push('tenant');
  scopes.push('platform');
  return scopes;
}

export function providerNotConfiguredBody(key: string, ctx: ConfigContext): ProviderNotConfigured {
  const scopes = scopesChecked(ctx);
  return {
    error: 'PROVIDER_NOT_CONFIGURED',
    provider_key: key,
    message:
      `No provider is configured for '${key}' at any of [${scopes.join(' -> ')}]. ` +
      `Set it via POST /api/config (or the relevant Settings page) to enable this feature.`,
    scopes_checked: scopes,
  };
}

/**
 * Returns null when a provider IS resolvable for `key` in `ctx` (the caller
 * should proceed), or the 503 PROVIDER_NOT_CONFIGURED body when nothing is
 * configured across the whole scope chain (the caller should
 * `reply.code(503).send(body)`).
 */
export async function checkProviderConfigured(
  key: string,
  ctx: ConfigContext,
): Promise<ProviderNotConfigured | null> {
  const row = await resolveConfig(key, ctx);
  return row ? null : providerNotConfiguredBody(key, ctx);
}
