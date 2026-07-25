'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button, Card, SetupChecklist, type SetupStep } from '@projexlight/design-system';
import { getToken } from '../../lib/apiClient';
import { TENANT_URL, CONSOLE_URL } from '../../lib/portalLinks';
import { logoutUser } from '../../services/authApi';
import { listConfig } from '../../services/configApi';

interface DecodedClaims {
  sub?: string;
  email?: string;
  tenant_id?: string | null;
  app_id?: string | null;
  org_id?: string | null;
  exp?: number;
}

/**
 * Best-effort client-side JWT decode (display only; never trust for auth
 * decisions). The gateway re-verifies on every API call.
 */
function decode(token: string): DecodedClaims | null {
  try {
    const payload = token.split('.')[1];
    const json = JSON.parse(atob(payload.replace(/-/g, '+').replace(/_/g, '/')));
    return json;
  } catch {
    return null;
  }
}

const TILES = [
  { href: '/build', label: 'Build with AI', desc: 'Compose a vertical app from blueprints via chat' },
  { href: '/dashboard/config', label: 'Configuration', desc: 'App settings & your personal keys' },
  { href: '/admin/audit', label: 'Audit ledger', desc: 'Append + verify the tamper-evident chain' },
  { href: '/admin/keys', label: 'Key hierarchy', desc: 'Vault key tiers + status' },
];

/** The onboarding steps shown on the dashboard, keyed to config rows. */
const SETUP_KEYS = {
  appLlm: 'llm.provider',
  personalKey: 'llm.personal_key',
  locale: 'prefs.locale',
} as const;

const EXTERNAL = [
  { href: TENANT_URL, label: 'Tenant Admin', desc: 'Members, billing, connectors, BYOK' },
  { href: CONSOLE_URL, label: 'Platform Console', desc: 'Operator-only (requires ADMIN_OPS_TOKEN)' },
];

function ClaimRow({ label, children }: { label: string; children: React.ReactNode }): JSX.Element {
  return (
    <div>
      <span className="inline-block w-24 text-muted-foreground">{label}</span> {children}
    </div>
  );
}

/**
 * /dashboard — post-login landing. Shows the current persona's six-layer
 * scope (so users know which tenant they're acting against), surface tiles
 * for the in-workspace tools, plus links to the admin consoles.
 */
export default function DashboardPage(): JSX.Element {
  const router = useRouter();
  const [claims, setClaims] = useState<DecodedClaims | null>(null);
  const [token, setLocalToken] = useState<string | null>(null);
  const [setup, setSetup] = useState<{ appLlm: boolean; personalKey: boolean; locale: boolean }>({
    appLlm: false,
    personalKey: false,
    locale: false,
  });

  useEffect(() => {
    const t = getToken();
    if (!t) {
      router.replace('/login');
      return;
    }
    setLocalToken(t);
    setClaims(decode(t));
    void (async () => {
      try {
        const [appRows, userRows] = await Promise.all([listConfig('app'), listConfig('app_user')]);
        const has = (rows: { key: string }[], key: string): boolean => rows.some((r) => r.key === key);
        setSetup({
          appLlm: has(appRows, SETUP_KEYS.appLlm),
          personalKey: has(userRows, SETUP_KEYS.personalKey),
          locale: has(userRows, SETUP_KEYS.locale),
        });
      } catch {
        // Degrade gracefully: leave all steps not-done.
      }
    })();
  }, [router]);

  const setupSteps: SetupStep[] = [
    {
      label: 'App LLM provider',
      description: 'Pick the default model provider for this app.',
      done: setup.appLlm,
      href: '/dashboard/config',
    },
    {
      label: 'Your personal LLM key',
      description: 'Add your own API key to use instead of the app default.',
      done: setup.personalKey,
      href: '/dashboard/config',
    },
    {
      label: 'Preferred locale',
      description: 'Set your language/region for dates and content.',
      done: setup.locale,
      href: '/dashboard/config',
    },
  ];

  const handleLogout = (): void => {
    logoutUser();
    router.push('/login');
  };

  if (!token) {
    return (
      <main className="mx-auto max-w-2xl px-6 py-10">
        <p className="text-muted-foreground">Checking session…</p>
      </main>
    );
  }

  return (
    <main className="mx-auto max-w-4xl px-6 py-10">
      <header className="mb-6 flex items-center justify-between">
        <h1 className="text-2xl font-bold tracking-tight">Workspace</h1>
        <Button variant="secondary" size="sm" onClick={handleLogout}>Sign out</Button>
      </header>

      <Card className="mb-7 bg-muted p-4 text-sm">
        <strong className="mb-2 block">Active session</strong>
        <ClaimRow label="Email:">{claims?.email ?? '(unknown)'}</ClaimRow>
        <ClaimRow label="Tenant ID:"><code>{claims?.tenant_id ?? '(none)'}</code></ClaimRow>
        <ClaimRow label="App ID:"><code>{claims?.app_id ?? '(none)'}</code></ClaimRow>
        <ClaimRow label="Org ID:"><code>{claims?.org_id ?? '(none)'}</code></ClaimRow>
        {claims?.exp && (
          <div className="mt-1.5 text-xs text-muted-foreground">
            Session expires: {new Date(claims.exp * 1000).toLocaleString()}
          </div>
        )}
      </Card>

      <SetupChecklist
        title="Get set up"
        subtitle="Personalize this app and add your own keys."
        steps={setupSteps}
        className="mb-7"
      />

      <h2 className="mb-3 text-lg font-semibold">In-workspace tools</h2>
      <div className="mb-7 grid grid-cols-[repeat(auto-fit,minmax(240px,1fr))] gap-3">
        {TILES.map((t) => (
          <Link key={t.href} href={t.href} className="block rounded-lg border bg-muted p-4 transition-colors hover:bg-accent">
            <div className="mb-1 font-semibold">{t.label}</div>
            <div className="text-sm text-muted-foreground">{t.desc}</div>
          </Link>
        ))}
      </div>

      <h2 className="mb-3 text-lg font-semibold">Other consoles</h2>
      <div className="grid grid-cols-[repeat(auto-fit,minmax(240px,1fr))] gap-3">
        {EXTERNAL.map((t) => (
          <a key={t.href} href={t.href} target="_blank" rel="noreferrer" className="block rounded-lg border bg-muted p-4 transition-colors hover:bg-accent">
            <div className="mb-1 font-semibold">{t.label} ↗</div>
            <div className="text-sm text-muted-foreground">{t.desc}</div>
          </a>
        ))}
      </div>
    </main>
  );
}
