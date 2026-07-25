import { cookies } from 'next/headers';
import { revalidatePath } from 'next/cache';
import { SESSION_COOKIE } from '@projexlight/design-system/auth';
import { ConfigForm, PageHeader } from '@projexlight/design-system';
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
    key: 'aws.s3',
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

/** Bearer header from the portal session cookie (tenant JWT). */
function bearer(): string {
  return cookies().get(SESSION_COOKIE)?.value ?? '';
}

/** Active tenant-scope config rows. Fail-soft: [] on any error. */
async function fetchTenantConfig(): Promise<ConfigRow[]> {
  try {
    const res = await fetch(`${GATEWAY}/api/config?scope=tenant`, {
      cache: 'no-store',
      headers: { Authorization: `Bearer ${bearer()}` },
    });
    if (!res.ok) return [];
    return (await res.json()).data ?? [];
  } catch {
    return [];
  }
}

/** Persist a tenant-scope value/secret. tenant_id is implicit in the JWT. */
async function saveConfigAction(
  key: string,
  payload: { value?: Record<string, unknown>; secret_ref?: string },
): Promise<{ ok: boolean; error?: string }> {
  'use server';
  try {
    const res = await fetch(`${GATEWAY}/api/config`, {
      method: 'POST',
      cache: 'no-store',
      headers: {
        'content-type': 'application/json',
        Authorization: `Bearer ${cookies().get(SESSION_COOKIE)?.value ?? ''}`,
      },
      body: JSON.stringify({ scope: 'tenant', key, ...payload }),
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

/** Revoke (soft-delete) a tenant-scope config value. */
async function revokeConfigAction(key: string): Promise<{ ok: boolean; error?: string }> {
  'use server';
  try {
    const res = await fetch(`${GATEWAY}/api/config/revoke`, {
      method: 'POST',
      cache: 'no-store',
      headers: {
        'content-type': 'application/json',
        Authorization: `Bearer ${cookies().get(SESSION_COOKIE)?.value ?? ''}`,
      },
      body: JSON.stringify({ scope: 'tenant', key }),
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

export default async function ConfigPage(): Promise<JSX.Element> {
  const rows = await fetchTenantConfig();
  const byKey = new Map(rows.map((r) => [r.key, r]));

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
        description="Bring your own providers for your tenant. Values here override the platform defaults."
      />
      <ConfigForm
        scope="tenant"
        entries={entries}
        onSave={saveConfigAction}
        onRevoke={revokeConfigAction}
      />
    </div>
  );
}
