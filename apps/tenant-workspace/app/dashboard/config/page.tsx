'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { ConfigForm, type ConfigEntry } from '@projexlight/design-system';
import { getToken } from '../../../lib/apiClient';
import { listConfig, setConfig, revokeConfig, type ConfigRow } from '../../../services/configApi';

/** Static definition of the settings surfaced at each scope. */
const APP_ENTRIES: ConfigEntry[] = [
  {
    key: 'llm.provider',
    label: 'App LLM override',
    description: 'Default model provider for everyone using this app.',
    kind: 'value',
    fields: [
      { name: 'provider', label: 'Provider', placeholder: 'openai' },
      { name: 'model', label: 'Model', placeholder: 'gpt-4o' },
    ],
  },
  {
    key: 'notification.email.credential',
    label: 'App email sender',
    description: 'Credential the app uses to send outbound email.',
    kind: 'secret',
    fields: [{ name: 'value', label: 'API key / DSN', secret: true }],
  },
];

const APP_USER_ENTRIES: ConfigEntry[] = [
  {
    key: 'llm.personal_key',
    label: 'Personal LLM key',
    description: 'Your own API key — used instead of the app default for you.',
    kind: 'secret',
    fields: [{ name: 'value', label: 'Your API key', secret: true }],
  },
  {
    key: 'prefs.locale',
    label: 'Preferred locale',
    description: 'Language/region used to format dates and content for you.',
    kind: 'value',
    fields: [{ name: 'value', label: 'Locale', placeholder: 'en-US' }],
  },
];

/** Overlay the live rows onto the static entry definitions (status/prefill). */
function withStatus(entries: ConfigEntry[], rows: ConfigRow[]): ConfigEntry[] {
  const byKey = new Map(rows.map((r) => [r.key, r]));
  return entries.map((e) => {
    const row = byKey.get(e.key);
    if (!row) return { ...e, configured: false };
    const secretRef = row.secret_ref ?? undefined;
    return {
      ...e,
      configured: true,
      last4: e.kind === 'secret' && secretRef ? secretRef.slice(-4) : undefined,
      currentValue: row.value,
    };
  });
}

/**
 * /dashboard/config — per-app + end-user configuration for the workspace portal.
 * Gated by middleware (protected /dashboard prefix). App-scope writes require the
 * caller be authenticated into the app (the JWT already is); app_user-scope
 * writes are the signed-in end user's own personal settings/keys.
 */
export default function ConfigPage(): JSX.Element {
  const router = useRouter();
  const [token, setLocalToken] = useState<string | null>(null);
  const [appEntries, setAppEntries] = useState<ConfigEntry[]>(APP_ENTRIES);
  const [userEntries, setUserEntries] = useState<ConfigEntry[]>(APP_USER_ENTRIES);

  useEffect(() => {
    const t = getToken();
    if (!t) {
      router.replace('/login');
      return;
    }
    setLocalToken(t);
    void (async () => {
      try {
        const [appRows, userRows] = await Promise.all([listConfig('app'), listConfig('app_user')]);
        setAppEntries(withStatus(APP_ENTRIES, appRows));
        setUserEntries(withStatus(APP_USER_ENTRIES, userRows));
      } catch {
        // Degrade to the un-configured defaults if the load fails.
      }
    })();
  }, [router]);

  async function saveApp(
    key: string,
    payload: { value?: Record<string, unknown>; secret_ref?: string },
  ): Promise<{ ok: boolean; error?: string }> {
    try {
      await setConfig({ scope: 'app', key, value: payload.value, secret_ref: payload.secret_ref });
      return { ok: true };
    } catch (e) {
      return { ok: false, error: String(e) };
    }
  }

  async function revokeApp(key: string): Promise<{ ok: boolean; error?: string }> {
    try {
      await revokeConfig('app', key);
      return { ok: true };
    } catch (e) {
      return { ok: false, error: String(e) };
    }
  }

  async function saveUser(
    key: string,
    payload: { value?: Record<string, unknown>; secret_ref?: string },
  ): Promise<{ ok: boolean; error?: string }> {
    try {
      await setConfig({ scope: 'app_user', key, value: payload.value, secret_ref: payload.secret_ref });
      return { ok: true };
    } catch (e) {
      return { ok: false, error: String(e) };
    }
  }

  async function revokeUser(key: string): Promise<{ ok: boolean; error?: string }> {
    try {
      await revokeConfig('app_user', key);
      return { ok: true };
    } catch (e) {
      return { ok: false, error: String(e) };
    }
  }

  if (!token) {
    return (
      <main className="mx-auto max-w-2xl px-6 py-10">
        <p className="text-muted-foreground">Checking session…</p>
      </main>
    );
  }

  return (
    <main className="mx-auto max-w-4xl px-6 py-10">
      <header className="mb-6">
        <h1 className="text-2xl font-bold tracking-tight">Configuration</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Tune this app for your whole team, and add your own personal keys.
        </p>
      </header>

      <section className="mb-9">
        <h2 className="mb-1 text-lg font-semibold">App settings</h2>
        <p className="mb-3 text-sm text-muted-foreground">
          Applies to everyone using this app in your tenant.
        </p>
        <ConfigForm scope="app" entries={appEntries} onSave={saveApp} onRevoke={revokeApp} />
      </section>

      <section>
        <h2 className="mb-1 text-lg font-semibold">Your personal keys</h2>
        <p className="mb-3 text-sm text-muted-foreground">
          Only affects your account — overrides the app defaults for you.
        </p>
        <ConfigForm scope="app_user" entries={userEntries} onSave={saveUser} onRevoke={revokeUser} />
      </section>
    </main>
  );
}
