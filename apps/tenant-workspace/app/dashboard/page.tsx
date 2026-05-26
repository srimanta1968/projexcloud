'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { getToken } from '../../lib/apiClient';
import { logoutUser } from '../../services/authApi';

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
  { href: '/build',       label: 'Build with AI', desc: 'Compose a vertical app from blueprints via chat' },
  { href: '/admin/audit', label: 'Audit ledger',  desc: 'Append + verify the tamper-evident chain' },
  { href: '/admin/keys',  label: 'Key hierarchy', desc: 'Vault key tiers + status' },
];

const EXTERNAL = [
  { href: 'http://localhost:3200',         label: 'Tenant Admin',  desc: 'Members, billing, connectors, BYOK' },
  { href: 'http://localhost:3100',         label: 'Platform Console', desc: 'Operator-only (requires ADMIN_OPS_TOKEN)' },
];

const CARD: React.CSSProperties = {
  display: 'block', padding: 16, background: '#f3f5f8', borderRadius: 8,
  textDecoration: 'none', color: 'inherit', border: '1px solid #d7dce4',
};

/**
 * /dashboard — post-login landing. Shows the current persona's six-layer
 * scope (so users know which tenant they're acting against), surface tiles
 * for the in-workspace tools, plus links to the admin consoles.
 */
export default function DashboardPage(): JSX.Element {
  const router = useRouter();
  const [claims, setClaims] = useState<DecodedClaims | null>(null);
  const [token, setLocalToken] = useState<string | null>(null);

  useEffect(() => {
    const t = getToken();
    if (!t) {
      router.replace('/login');
      return;
    }
    setLocalToken(t);
    setClaims(decode(t));
  }, [router]);

  const handleLogout = (): void => {
    logoutUser();
    router.push('/login');
  };

  if (!token) {
    return (
      <main style={{ maxWidth: 640, margin: '0 auto', padding: '40px 24px', fontFamily: 'system-ui, sans-serif' }}>
        <p style={{ color: '#5a6573' }}>Checking session…</p>
      </main>
    );
  }

  return (
    <main style={{ maxWidth: 880, margin: '0 auto', padding: '40px 24px', fontFamily: 'system-ui, sans-serif' }}>
      <header style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 24 }}>
        <h1 style={{ margin: 0 }}>Workspace</h1>
        <button
          onClick={handleLogout}
          style={{ background: '#f3f5f8', border: '1px solid #d7dce4', padding: '6px 14px', borderRadius: 6, cursor: 'pointer', fontSize: 13 }}>
          Sign out
        </button>
      </header>

      <section style={{ background: '#f1f5fb', border: '1px solid #d3dbe8', borderRadius: 8, padding: 16, marginBottom: 28, fontSize: 14 }}>
        <strong style={{ display: 'block', marginBottom: 8 }}>Active session</strong>
        <div><span style={{ color: '#5a6573', width: 90, display: 'inline-block' }}>Email:</span> {claims?.email ?? '(unknown)'}</div>
        <div><span style={{ color: '#5a6573', width: 90, display: 'inline-block' }}>Tenant ID:</span> <code>{claims?.tenant_id ?? '(none)'}</code></div>
        <div><span style={{ color: '#5a6573', width: 90, display: 'inline-block' }}>App ID:</span> <code>{claims?.app_id ?? '(none)'}</code></div>
        <div><span style={{ color: '#5a6573', width: 90, display: 'inline-block' }}>Org ID:</span> <code>{claims?.org_id ?? '(none)'}</code></div>
        {claims?.exp && (
          <div style={{ marginTop: 6, color: '#7a8597', fontSize: 12 }}>
            Session expires: {new Date(claims.exp * 1000).toLocaleString()}
          </div>
        )}
      </section>

      <h2 style={{ fontSize: 18, marginBottom: 12 }}>In-workspace tools</h2>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: 12, marginBottom: 28 }}>
        {TILES.map((t) => (
          <Link key={t.href} href={t.href} style={CARD}>
            <div style={{ fontWeight: 600, marginBottom: 4 }}>{t.label}</div>
            <div style={{ fontSize: 13, color: '#5a6573' }}>{t.desc}</div>
          </Link>
        ))}
      </div>

      <h2 style={{ fontSize: 18, marginBottom: 12 }}>Other consoles</h2>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: 12 }}>
        {EXTERNAL.map((t) => (
          <a key={t.href} href={t.href} target="_blank" rel="noreferrer" style={CARD}>
            <div style={{ fontWeight: 600, marginBottom: 4 }}>{t.label} ↗</div>
            <div style={{ fontSize: 13, color: '#5a6573' }}>{t.desc}</div>
          </a>
        ))}
      </div>
    </main>
  );
}
