import { IntlMessageFormat } from 'intl-messageformat';

export type LocaleId = string;
export type MessageBundle = Record<string, string>;

const _bundles: Record<LocaleId, MessageBundle> = {};
const _tenantOverrides: Record<string, Record<LocaleId, MessageBundle>> = {};
let _defaultLocale: LocaleId = 'en-US';

/**
 * Loads (or replaces) a locale bundle into the registry. Bundles are flat
 * key→ICU-message records; nested keys use dots (`auth.login.title`).
 */
export function registerLocaleBundle(locale: LocaleId, bundle: MessageBundle): void {
  _bundles[locale] = { ..._bundles[locale], ...bundle };
}

export function registerTenantOverride(tenant_id: string, locale: LocaleId, bundle: MessageBundle): void {
  _tenantOverrides[tenant_id] ??= {};
  _tenantOverrides[tenant_id][locale] = {
    ..._tenantOverrides[tenant_id]?.[locale],
    ...bundle,
  };
}

export function setDefaultLocale(locale: LocaleId): void {
  _defaultLocale = locale;
}

/**
 * Resolves and formats a message key for a (tenant, locale) context. Falls
 * back tenant override → locale → default locale → key itself.
 */
export function t(
  key: string,
  values: Record<string, string | number | Date> = {},
  ctx: { tenant_id?: string; locale?: LocaleId } = {},
): string {
  const locale = ctx.locale ?? _defaultLocale;
  const tenantBundle = ctx.tenant_id ? _tenantOverrides[ctx.tenant_id]?.[locale] : undefined;
  const localeBundle = _bundles[locale];
  const defaultBundle = _bundles[_defaultLocale];

  const raw =
    tenantBundle?.[key] ??
    localeBundle?.[key] ??
    defaultBundle?.[key] ??
    key;

  try {
    return new IntlMessageFormat(raw, locale).format(values) as string;
  } catch {
    return raw;
  }
}
