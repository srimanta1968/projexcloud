import Link from 'next/link';

export default function Home(): JSX.Element {
  return (
    <main style={{ maxWidth: 640, margin: '0 auto', padding: '60px 24px', fontFamily: 'system-ui, sans-serif' }}>
      <h1 style={{ fontSize: 36, marginBottom: 8 }}>ProjexCloud</h1>
      <p style={{ color: '#5a6573', fontSize: 16 }}>
        The multi-tenant SaaS workspace with built-in identity, billing, audit, and AI.
      </p>

      <div style={{ display: 'flex', gap: 12, marginTop: 32 }}>
        <Link
          href="/signup"
          style={{
            background: '#0b1220', color: '#fff', padding: '12px 24px',
            borderRadius: 6, textDecoration: 'none', fontSize: 15, fontWeight: 600,
          }}
        >
          Start a free trial
        </Link>
        <Link
          href="/register"
          style={{
            background: '#f3f5f8', color: '#0b1220', padding: '12px 24px',
            borderRadius: 6, textDecoration: 'none', fontSize: 15,
            border: '1px solid #d7dce4',
          }}
        >
          I was invited
        </Link>
      </div>

      <p style={{ marginTop: 32, fontSize: 13, color: '#7a8597' }}>
        Already have a workspace? Tenant admins manage their workspace at{' '}
        <a href="http://localhost:3200">localhost:3200</a>.
      </p>
    </main>
  );
}
