import { gateway } from '@/lib/gateway';
import {
  type ProviderDescriptor,
  splitSecretFields,
} from '@/lib/providerDescriptors';

/**
 * Scope-aware configuration reads and writes (TK-4130 · TK-4132).
 *
 * WHAT THE CONFIG PLANE ALREADY DOES, AND WHAT THE UI WAS MISSING
 * config.config_value is unique on (scope, scope_id, key) and resolveConfig walks
 *   app_user -> app -> tenant -> platform, first match wins.
 * That is already "set it once for all my apps, override it for one app" — no schema change
 * needed. What the portal lacked was any way to SEE which scope answered, so an admin could
 * not tell an inherited value from one set here, and therefore could not tell whether editing
 * it would affect one app or all of them. A setting whose origin is invisible is one nobody
 * dares change.
 *
 * resolveEntry() below returns BOTH the effective value (with its origin) and whether an
 * override exists at the scope being edited, which is what lets the page label a row
 * "inherited from tenant" versus "overridden here" and make overriding an explicit act.
 */

export type ConfigScope = 'platform' | 'tenant' | 'app' | 'app_user';

/** Most-specific first — the same order resolveConfig uses server-side. */
export const SCOPE_PRECEDENCE: ConfigScope[] = ['app_user', 'app', 'tenant', 'platform'];

export interface ResolvedEntry {
  key: string;
  /** The scope that actually answered, or null when nothing is set anywhere. */
  resolvedFrom: ConfigScope | null;
  value: Record<string, unknown> | null;
  secret_ref: string | null;
  /** True when a row exists at the scope currently being edited. */
  overriddenHere: boolean;
}

/**
 * Resolve one key for a context and report its origin.
 *
 * Two calls on purpose: /resolve gives the EFFECTIVE value after the chain walk, /value gives
 * the row at this exact scope. Comparing them is the only way to distinguish "inherited" from
 * "set here to the same value" — and those differ when you delete: one falls back, the other
 * changes nothing.
 */
export async function resolveEntry(
  key: string,
  ctx: { scope: ConfigScope; scope_id?: string; tenant_id?: string; app_id?: string },
): Promise<ResolvedEntry> {
  const q = new URLSearchParams({ key });
  if (ctx.tenant_id) q.set('tenant_id', ctx.tenant_id);
  if (ctx.app_id) q.set('app_id', ctx.app_id);

  let resolved: { scope?: ConfigScope; value?: Record<string, unknown> | null; secret_ref?: string | null } | null = null;
  try {
    resolved = await gateway.get(`/api/config/resolve?${q.toString()}`);
  } catch {
    resolved = null;
  }

  let here: { config_id?: string } | null = null;
  try {
    const q2 = new URLSearchParams({ key, scope: ctx.scope });
    if (ctx.scope_id) q2.set('scope_id', ctx.scope_id);
    here = await gateway.get(`/api/config/value?${q2.toString()}`);
  } catch {
    here = null;
  }

  return {
    key,
    resolvedFrom: (resolved?.scope as ConfigScope) ?? null,
    value: resolved?.value ?? null,
    secret_ref: resolved?.secret_ref ?? null,
    overriddenHere: Boolean(here?.config_id),
  };
}

/** Human label for a row, so the page never has to re-derive the rule. */
export function originLabel(entry: ResolvedEntry, editingScope: ConfigScope): string {
  if (entry.resolvedFrom === null) return 'Not configured';
  if (entry.overriddenHere) return `Overridden at ${editingScope}`;
  if (entry.resolvedFrom === 'platform') return 'Platform default';
  return `Inherited from ${entry.resolvedFrom}`;
}

/**
 * Save a provider, routing every secret-flagged field to the vault.
 *
 * THIS IS THE SECURITY BOUNDARY. config_value.value is plain JSONB and is returned by ordinary
 * GET /api/config reads — anything written there is readable by every caller allowed to read
 * configuration. So credentials go to secret_ref via sdk-secrets and NEVER into value. The
 * split is done by splitSecretFields() from the descriptor rather than per-page, because
 * "remember to route the api_key" is the kind of rule that holds until someone adds a provider
 * in a hurry.
 *
 * Returns the secret refs written, so a caller can show "•••• 1234" without ever holding the
 * plaintext again.
 */
export async function saveProvider(
  descriptor: ProviderDescriptor,
  submitted: Record<string, unknown>,
  target: { scope: ConfigScope; scope_id?: string },
): Promise<{ ok: boolean; error?: string; secretRefs: string[] }> {
  const { value, secrets } = splitSecretFields(descriptor, submitted);
  const secretRefs: string[] = [];

  try {
    // Secrets first: if the vault write fails we must NOT leave a config row implying the
    // provider is configured when its credential never landed.
    for (const [name, plaintext] of Object.entries(secrets)) {
      const scopeSeg = target.scope === 'app' ? 'app' : 'tenant';
      const id = target.scope_id || 'self';
      const stored = await gateway.post<{ ref?: string }>('/api/secrets', {
        ref: `secret://${scopeSeg}/${descriptor.key}.${descriptor.driver}.${name}.${id}`,
        value: String(plaintext),
      });
      if (stored?.ref) secretRefs.push(stored.ref);
    }

    await gateway.post('/api/config', {
      scope: target.scope,
      ...(target.scope_id ? { scope_id: target.scope_id } : {}),
      key: descriptor.key,
      value,
      ...(secretRefs.length ? { secret_ref: secretRefs[0] } : {}),
    });

    return { ok: true, secretRefs };
  } catch (err) {
    return { ok: false, error: (err as Error).message, secretRefs };
  }
}

/**
 * Remove an override at this scope so the value falls back to the next scope up.
 *
 * Deliberately NOT called "delete": the setting does not disappear, it reverts to whatever the
 * parent scope says, and labelling it delete is what makes admins afraid to undo an override.
 */
export async function removeOverride(
  key: string,
  target: { scope: ConfigScope; scope_id?: string },
): Promise<{ ok: boolean; error?: string }> {
  try {
    await gateway.post('/api/config/revoke', {
      scope: target.scope,
      ...(target.scope_id ? { scope_id: target.scope_id } : {}),
      key,
    });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}
