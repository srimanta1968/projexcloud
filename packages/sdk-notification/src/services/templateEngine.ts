import { dataService } from '@projexlight/db-runtime';
import type {
  NotificationChannel,
  TemplateRecord,
} from '../models/notification.model';

/**
 * Template engine per FR-NTF-3.
 *
 * Resolves the template for (tenant_id, code, channel):
 *   1. Tenant-override row wins
 *   2. Falls back to platform-default (tenant_id NULL)
 *
 * Renders ICU-style messages from `locale_bundles[locale][key]`. We support
 * basic `{var}` substitution + plural-form selection via `plural:{var, =1{...} other{...}}`.
 * For full ICU MessageFormat we'd swap to `intl-messageformat` at the deploy
 * level; the in-process renderer here is plenty for transactional notifications.
 */

export class TemplateNotFoundError extends Error {
  readonly code = 'TemplateNotFound';
  constructor(template_code: string, channel: string) {
    super(`No active template for code=${template_code} channel=${channel}`);
  }
}

export async function resolveTemplate(
  tenant_id: string,
  code: string,
  channel: NotificationChannel,
): Promise<TemplateRecord> {
  const tenantOverride = await dataService.one<TemplateRecord>(
    `SELECT template_id, tenant_id, code, channel, locale_bundles,
            required_consent_purpose, version, status, created_at
       FROM notification.template
      WHERE tenant_id = $1 AND code = $2 AND channel = $3 AND status = 'active'
      ORDER BY version DESC
      LIMIT 1`,
    [tenant_id, code, channel],
  );
  if (tenantOverride) return tenantOverride;

  const platformDefault = await dataService.one<TemplateRecord>(
    `SELECT template_id, tenant_id, code, channel, locale_bundles,
            required_consent_purpose, version, status, created_at
       FROM notification.template
      WHERE tenant_id IS NULL AND code = $1 AND channel = $2 AND status = 'active'
      ORDER BY version DESC
      LIMIT 1`,
    [code, channel],
  );
  if (!platformDefault) {
    throw new TemplateNotFoundError(code, channel);
  }
  return platformDefault;
}

/**
 * Minimal ICU-style renderer. Supports:
 *   - {name}                     → variable substitution
 *   - {count, plural, =1{...} other{...}}  → plural form
 */
export function renderTemplate(
  template: TemplateRecord,
  locale: string,
  variables: Record<string, unknown>,
): string {
  // Locale fallback chain: requested → 'en-US' → 'en' → first available.
  const bundle =
    template.locale_bundles[locale] ??
    template.locale_bundles['en-US'] ??
    template.locale_bundles['en'] ??
    template.locale_bundles[Object.keys(template.locale_bundles)[0]];
  if (!bundle) {
    throw new Error(`Template ${template.template_id} has no locale bundles`);
  }
  // Use 'body' key as the primary rendered field; templates can also expose
  // 'subject' (email) etc. We render whichever the caller asks for via the
  // pseudo-key 'body' which is the standard contract.
  const raw = bundle.body ?? Object.values(bundle)[0];
  if (typeof raw !== 'string') {
    throw new Error(`Template ${template.template_id} bundle for ${locale} has no body string`);
  }
  return interpolate(raw, variables);
}

function interpolate(str: string, vars: Record<string, unknown>): string {
  // Plural form first so {count} inside doesn't get pre-substituted
  str = str.replace(
    /\{(\w+),\s*plural,\s*=1\s*\{([^}]*)\}\s*other\s*\{([^}]*)\}\s*\}/g,
    (_match, key: string, one: string, other: string) => {
      const value = Number(vars[key]);
      return value === 1 ? interpolate(one, vars) : interpolate(other, vars);
    },
  );
  // Plain variables
  return str.replace(/\{(\w+)\}/g, (_match, key: string) => {
    return vars[key] != null ? String(vars[key]) : '';
  });
}
