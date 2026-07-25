import { resolveConfig, type ConfigContext } from '@projexlight/sdk-config';

/**
 * The two payment "levels" of the config plane (EP-341, TK-3797):
 *   - 'billing' — how a TENANT pays ProjexLight. Resolved at PLATFORM scope only
 *     (a tenant can't override how it is billed), i.e. the platform payment
 *     provider ProjexLight collects with.
 *   - 'collect' — how a TENANT collects from its own end-users. Resolved at the
 *     caller's scope chain (tenant -> platform), so a tenant's own payment
 *     provider is used, falling back to the platform default.
 */
export type PaymentLevel = 'billing' | 'collect';

export interface ResolvedPaymentProvider {
  level: PaymentLevel;
  configured: boolean;
  /** The provider name (e.g. 'stripe') from the resolved config, or null. */
  provider: string | null;
  /** The scope the value resolved from (platform|tenant|...), or null. */
  scope: string | null;
  /** The full resolved non-secret config value, or null. */
  value: Record<string, unknown> | null;
}

/**
 * Resolve the payment provider for a given level via the config plane. This is
 * the two-level counterpart to checkProviderConfigured('payment.provider'): it
 * tells the caller WHICH provider to route through (and at which scope it was
 * configured), so platform billing and per-tenant collection can use different
 * providers from one shared config key.
 */
export async function resolvePaymentProviderByScope(
  ctx: ConfigContext,
  level: PaymentLevel,
): Promise<ResolvedPaymentProvider> {
  // Billing ignores tenant/app overrides — only the platform provider bills.
  const resolveCtx: ConfigContext = level === 'billing' ? {} : ctx;
  const row = await resolveConfig('payment.provider', resolveCtx);
  const value = row?.value ?? null;
  return {
    level,
    configured: !!row,
    provider: (value?.provider as string | undefined) ?? null,
    scope: row?.scope ?? null,
    value,
  };
}
