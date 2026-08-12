import { cookies } from 'next/headers';
import { revalidatePath } from 'next/cache';
import { SESSION_COOKIE } from '@projexlight/design-system/auth';
import { ConfigForm, PageHeader } from '@projexlight/design-system';
import { PROVIDER_DESCRIPTORS, toConfigEntry, splitSecretFields } from '@/lib/providerDescriptors';
import { resolveEntry, originLabel, saveProvider, removeOverride } from '@/lib/scopedConfig';

/*
 * The scope switcher below uses plain <a> deliberately (an explicit navigation,
 * so the admin can see in the URL which scope they are about to write to), and
 * Next only rewrites hrefs for <Link>. A bare href="/config" therefore leaves the
 * portal: on cloud.projexlight.com it resolves to /config, which is not a portal
 * route but the api-gateway, whose default-deny gate answers
 * {"error":"Unauthorized","details":["Missing bearer token"]}. Prefixing by hand
 * is what keeps these links inside /tenant.
 */
const BASE_PATH = process.env.NEXT_PUBLIC_BASE_PATH ?? '';
import type { ConfigEntry } from '@projexlight/design-system';

/**
 * Unified tenant Settings / Integrations hub (tenant-admin, EP-341).
 *
 * One page where a tenant admin brings their own providers — AWS/S3 storage,
 * payment collection, search backend, email and an LLM override. Values written
 * here are TENANT-scoped and override the platform defaults for this tenant's
 * apps.
 *
 * Auth: the `projexlight.session` cookie is a valid tenant JWT. The gateway
 * derives tenant_id from the token, so we pass scope='tenant' WITHOUT a
 * scope_id (the gateway defaults it to the caller's tenant) and never send an
 * admin ops-token.
 */

export const dynamic = 'force-dynamic';

const GATEWAY = process.env.NEXT_PUBLIC_GATEWAY_URL;

/** A config row as returned by GET /api/config (config.config_value). */
interface ConfigRow {
  config_id: string;
  scope: string;
  scope_id: string;
  key: string;
  value: Record<string, unknown> | null;
  secret_ref: string | null;
  status: string;
}

/** Static definition of every tenant-scoped card rendered on this page. */
const TENANT_CARDS: ConfigEntry[] = [
  {
    key: 'media.s3',
    label: 'AWS / S3 storage',
    description: 'Store your app files in your own S3 bucket.',
    kind: 'value',
    fields: [
      { name: 'bucket', label: 'Bucket' },
      { name: 'region', label: 'Region', placeholder: 'us-east-1' },
    ],
  },
  {
    key: 'payment.provider',
    label: 'Payment collection (your customers -> you)',
    description: 'The provider your app uses to collect payments from your customers.',
    kind: 'value',
    fields: [{ name: 'provider', label: 'Provider', placeholder: 'stripe' }],
  },
  {
    key: 'search.provider',
    label: 'Search backend',
    description: 'Search endpoint your app queries.',
    kind: 'value',
    fields: [{ name: 'endpoint', label: 'Endpoint' }],
  },
  {
    key: 'notification.email.credential',
    label: 'Email provider (BYO)',
    description: 'Credential for outbound email from your own provider. Stored write-only.',
    kind: 'secret',
    fields: [{ name: 'secret', label: 'API key / SMTP DSN', secret: true }],
  },
  {
    key: 'llm.provider',
    label: 'LLM provider override',
    description: 'Override the platform default model for your tenant.',
    kind: 'value',
    fields: [
      { name: 'provider', label: 'Provider' },
      { name: 'model', label: 'Model' },
    ],
  },
];

/** The tenant's applications — the choices in the scope switcher. */
async function fetchApplications(): Promise<Array<{ application_id: string; name: string }>> {
  try {
    const res = await fetch(`${GATEWAY}/api/applications`, {
      headers: { Authorization: `Bearer ${bearer()}` },
      cache: 'no-store',
    });
    if (!res.ok) return [];
    const body = await res.json();
    return (body?.data ?? body ?? []) as Array<{ application_id: string; name: string }>;
  } catch {
    return [];
  }
}

/** Bearer header from the portal session cookie (tenant JWT). */
function bearer(): string {
  return cookies().get(SESSION_COOKIE)?.value ?? '';
}

/** Active config rows AT ONE EXACT SCOPE (no chain walk). Fail-soft: [] on error. */
async function fetchScopeConfig(scope: string, scopeId?: string): Promise<ConfigRow[]> {
  try {
    const qs = new URLSearchParams({ scope });
    if (scopeId) qs.set('scope_id', scopeId);
    const res = await fetch(`${GATEWAY}/api/config?${qs.toString()}`, {
      cache: 'no-store',
      headers: { Authorization: `Bearer ${bearer()}` },
    });
    if (!res.ok) return [];
    return (await res.json()).data ?? [];
  } catch {
    return [];
  }
}

/**
 * Persist a value/secret at the scope being edited. tenant_id is implicit in the JWT.
 *
 * `scopeId` is BOUND at render time (`.bind(null, appId)`) rather than passed by
 * ConfigForm, whose onSave signature is fixed and shared across portals. Binding
 * keeps the target scope with the action that will run, instead of leaving a
 * server action to guess which tab produced it.
 */
async function saveConfigAction(
  scopeId: string,
  key: string,
  payload: { value?: Record<string, unknown>; secret_ref?: string },
): Promise<{ ok: boolean; error?: string }> {
  'use server';
  const scope = scopeId ? 'app' : 'tenant';
  try {
    const res = await fetch(`${GATEWAY}/api/config`, {
      method: 'POST',
      cache: 'no-store',
      headers: {
        'content-type': 'application/json',
        Authorization: `Bearer ${cookies().get(SESSION_COOKIE)?.value ?? ''}`,
      },
      body: JSON.stringify({ scope, ...(scopeId ? { scope_id: scopeId } : {}), key, ...payload }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      return { ok: false, error: body?.details?.[0] || body?.error || `Save failed (${res.status})` };
    }
    revalidatePath('/config');
    return { ok: true };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

/** Revoke (soft-delete) the override at the scope being edited. */
async function revokeConfigAction(scopeId: string, key: string): Promise<{ ok: boolean; error?: string }> {
  'use server';
  const scope = scopeId ? 'app' : 'tenant';
  try {
    const res = await fetch(`${GATEWAY}/api/config/revoke`, {
      method: 'POST',
      cache: 'no-store',
      headers: {
        'content-type': 'application/json',
        Authorization: `Bearer ${cookies().get(SESSION_COOKIE)?.value ?? ''}`,
      },
      body: JSON.stringify({ scope, ...(scopeId ? { scope_id: scopeId } : {}), key }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      return { ok: false, error: body?.details?.[0] || body?.error || `Remove failed (${res.status})` };
    }
    revalidatePath('/config');
    return { ok: true };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

/**
 * Persist one provider from its descriptor. Secrets are routed to secret_ref by
 * splitSecretFields via saveProvider — never written into config_value.value, which is
 * plain JSONB returned by ordinary config reads.
 */
async function saveProviderAction(formData: FormData): Promise<void> {
  'use server';
  const descriptorKey = String(formData.get('__descriptor') ?? '');
  const descriptor = PROVIDER_DESCRIPTORS.find(
    (d) => `${d.key}:${d.driver}` === descriptorKey,
  );
  if (!descriptor) return;

  const submitted: Record<string, unknown> = {};
  for (const f of descriptor.fields) {
    const v = formData.get(f.name);
    if (typeof v === 'string' && v.trim()) submitted[f.name] = v.trim();
  }
  // The scope being edited travels in the form, not in module state: a server
  // action has no memory of which tab rendered it, and defaulting to 'tenant'
  // here would silently write a tenant-wide value while the admin believed they
  // were overriding one app.
  const scopeId = String(formData.get('__scope_id') ?? '');
  await saveProvider(descriptor, submitted, scopeId ? { scope: 'app', scope_id: scopeId } : { scope: 'tenant' });
  revalidatePath('/config');
}

/** Remove the tenant override so the key falls BACK to the platform default. */
async function removeOverrideAction(formData: FormData): Promise<void> {
  'use server';
  const key = String(formData.get('__key') ?? '');
  if (!key) return;
  const scopeId = String(formData.get('__scope_id') ?? '');
  await removeOverride(key, scopeId ? { scope: 'app', scope_id: scopeId } : { scope: 'tenant' });
  revalidatePath('/config');
}

export default async function ConfigPage({
  searchParams,
}: {
  searchParams?: { app?: string };
}): Promise<JSX.Element> {
  // The edited scope lives in the URL, not in client state, so the page stays a
  // server component and a chosen app survives a reload, a bookmark and the
  // redirect that follows every save.
  const apps = await fetchApplications();
  const appId = searchParams?.app && apps.some((a) => a.application_id === searchParams.app)
    ? searchParams.app
    : '';
  const scope = appId ? 'app' : 'tenant';
  const scopeCtx = appId ? { scope: 'app' as const, scope_id: appId } : { scope: 'tenant' as const };

  const rows = await fetchScopeConfig(scope, appId || undefined);
  const byKey = new Map(rows.map((r) => [r.key, r]));

  // Resolve each provider key through the chain so the card can state WHICH scope
  // answered. Without this the page is scope-blind: an admin cannot tell a value
  // inherited from the platform from one set here, and so cannot tell whether editing
  // it affects one app or all of them.
  const providerKeys = [...new Set(PROVIDER_DESCRIPTORS.map((d) => d.key))];
  const resolved = await Promise.all(
    providerKeys.map((k) => resolveEntry(k, scopeCtx)),
  );
  const originByKey = new Map(
    resolved.map((r) => [r.key, { label: originLabel(r, scope), overridden: r.overriddenHere }]),
  );

  const entries: ConfigEntry[] = TENANT_CARDS.map((c) => {
    const row = byKey.get(c.key);
    const configured = !!row;
    if (c.kind === 'secret') {
      const ref = row?.secret_ref ?? undefined;
      return {
        ...c,
        configured,
        last4: ref ? ref.slice(-4) : undefined,
      };
    }
    return {
      ...c,
      configured,
      currentValue: row?.value ?? null,
    };
  });

  return (
    <div>
      <PageHeader
        title="Settings & Integrations"
        description={
          appId
            ? 'Editing ONE app. A value saved here overrides what this app inherits from the tenant; every other app is unaffected.'
            : 'Editing the tenant default. Every one of your apps inherits these values unless it overrides them.'
        }
      />

      {/* Scope switcher. Plain links, so choosing a scope is an explicit
          navigation rather than a hidden mode toggle — an admin can see in the
          URL which scope they are about to write to. */}
      <nav aria-label="Configuration scope" style={{ display: 'flex', gap: 8, flexWrap: 'wrap', margin: '12px 0 20px' }}>
        <a
          href={`${BASE_PATH}/config`}
          aria-current={!appId ? 'page' : undefined}
          style={{
            padding: '6px 12px', borderRadius: 6, fontSize: 13, textDecoration: 'none',
            border: '1px solid #30363d', color: !appId ? '#0d1117' : '#c9d1d9',
            background: !appId ? '#58a6ff' : 'transparent',
          }}
        >
          All apps (tenant default)
        </a>
        {apps.map((a) => (
          <a
            key={a.application_id}
            href={`${BASE_PATH}/config?app=${encodeURIComponent(a.application_id)}`}
            aria-current={appId === a.application_id ? 'page' : undefined}
            style={{
              padding: '6px 12px', borderRadius: 6, fontSize: 13, textDecoration: 'none',
              border: '1px solid #30363d',
              color: appId === a.application_id ? '#0d1117' : '#c9d1d9',
              background: appId === a.application_id ? '#58a6ff' : 'transparent',
            }}
          >
            {a.name}
          </a>
        ))}
      </nav>

      <ConfigForm
        scope={scope}
        entries={entries}
        onSave={saveConfigAction.bind(null, appId)}
        onRevoke={revokeConfigAction.bind(null, appId)}
      />

      {/* ── Providers, rendered from descriptors ───────────────────────────── */}
      <section className="mt-10">
        <h2 className="text-lg font-medium mb-1">Providers</h2>
        <p className="text-sm text-gray-500 mb-4">
          Each card shows which scope currently answers for that key. Saving here creates a
          tenant-scope value that all of your apps inherit unless an app overrides it.
        </p>

        {PROVIDER_DESCRIPTORS.map((d) => {
          const origin = originByKey.get(d.key);
          return (
            <div key={`${d.key}:${d.driver}`} className="border rounded p-4 mb-4">
              <div className="flex items-baseline justify-between mb-1">
                <h3 className="font-medium">{d.label}</h3>
                {/* The origin badge — AC1. */}
                <span className="text-xs text-gray-500" data-testid={`origin-${d.key}`}>
                  {origin?.label ?? 'Not configured'}
                </span>
              </div>
              <p className="text-sm text-gray-500 mb-3">{d.description}</p>

              <form action={saveProviderAction} className="space-y-2">
                <input type="hidden" name="__descriptor" value={`${d.key}:${d.driver}`} />
                {d.fields.map((f) => (
                  <div key={f.name}>
                    <label className="block text-xs text-gray-600" htmlFor={`${d.driver}-${f.name}`}>
                      {f.label}{f.secret ? ' (stored in the vault)' : ''}
                    </label>
                    <input
                      id={`${d.driver}-${f.name}`}
                      name={f.name}
                      type={f.secret ? 'password' : 'text'}
                      placeholder={f.placeholder}
                      className="border rounded px-2 py-1 text-sm w-full"
                    />
                    {f.hint && <p className="text-xs text-gray-400 mt-0.5">{f.hint}</p>}
                  </div>
                ))}
                <button type="submit" className="text-sm px-3 py-1 border rounded">
                  Save for all my apps
                </button>
              </form>

              {/* Removal is a FALLBACK, not a delete — AC3. Offered only when an override
                  actually exists here, so the button never lies about what it will do. */}
              {origin?.overridden && (
                <form action={removeOverrideAction} className="mt-2">
                  <input type="hidden" name="__key" value={d.key} />
                  <button type="submit" className="text-xs px-2 py-1 border rounded">
                    Remove override (falls back to the platform default)
                  </button>
                </form>
              )}
            </div>
          );
        })}
      </section>
    </div>
  );
}
