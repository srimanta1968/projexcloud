import { revalidatePath } from 'next/cache';
import { cookies } from 'next/headers';

interface KeyRow {
  key_id: string;
  name: string;
  scope: string;
  status: string;
  issued_at: string;
  last_used_at: string | null;
  expires_at: string | null;
}

const TENANT_ID = process.env.TENANT_ADMIN_TENANT_ID ?? '';

async function fetchKeys(): Promise<KeyRow[]> {
  if (!TENANT_ID) return [];
  try {
    const res = await fetch(
      `${process.env.NEXT_PUBLIC_GATEWAY_URL}/api/keys?tenant_id=${encodeURIComponent(TENANT_ID)}`,
      { cache: 'no-store' },
    );
    if (!res.ok) return [];
    return (await res.json()).data ?? [];
  } catch { return []; }
}

async function issueKey(formData: FormData): Promise<void> {
  'use server';
  const name = String(formData.get('name') ?? '');
  const scope = String(formData.get('scope') ?? '');
  const res = await fetch(`${process.env.NEXT_PUBLIC_GATEWAY_URL}/api/keys`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ tenant_id: TENANT_ID, name, scope }),
  });
  if (res.ok) {
    const body = await res.json();
    // Stash plaintext in an httpOnly cookie so the next render can show + clear it.
    cookies().set('issued_key_plaintext', body.data?.plaintext ?? '', { httpOnly: false, maxAge: 60 });
    cookies().set('issued_key_id', body.data?.key_id ?? '', { httpOnly: false, maxAge: 60 });
  }
  revalidatePath('/api-keys');
}

async function revokeKey(formData: FormData): Promise<void> {
  'use server';
  const key_id = String(formData.get('key_id') ?? '');
  await fetch(`${process.env.NEXT_PUBLIC_GATEWAY_URL}/api/keys/${encodeURIComponent(key_id)}/revoke`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ reason: String(formData.get('reason') ?? 'tenant-admin revoke') }),
  });
  revalidatePath('/api-keys');
}

export default async function ApiKeysPage(): Promise<JSX.Element> {
  const keys = await fetchKeys();
  const issuedPlaintext = cookies().get('issued_key_plaintext')?.value;
  const issuedId = cookies().get('issued_key_id')?.value;
  if (issuedPlaintext) {
    // One-shot reveal; clear after rendering.
    cookies().delete('issued_key_plaintext');
    cookies().delete('issued_key_id');
  }
  return (
    <div>
      <h1>API keys</h1>
      <p style={{ color: '#5a6573' }}>Issue, view, and revoke API keys for this tenant.</p>

      {issuedPlaintext && (
        <div style={{ background: '#e7f4ea', border: '1px solid #5dd39e', padding: 12, marginTop: 12, borderRadius: 6 }}>
          <strong>Save this key now — it won&apos;t be shown again.</strong>
          <div style={{ fontFamily: 'monospace', marginTop: 6, wordBreak: 'break-all' }}>{issuedPlaintext}</div>
          <div style={{ fontSize: 12, color: '#5a6573', marginTop: 4 }}>key_id: {issuedId}</div>
        </div>
      )}

      <section style={{ marginTop: 24, padding: 16, border: '1px solid #d7dce4', borderRadius: 8, maxWidth: 640 }}>
        <h2 style={{ marginTop: 0 }}>Issue new key</h2>
        <form action={issueKey} style={{ display: 'grid', gap: 12 }}>
          <label>Name <input name="name" required style={{ display: 'block', width: '100%', padding: 6 }} /></label>
          <label>Scope <input name="scope" required style={{ display: 'block', width: '100%', padding: 6 }} placeholder="read:*, write:engagement" /></label>
          <button type="submit" style={{ padding: '8px 16px', background: '#1b2a44', color: 'white', border: 'none', borderRadius: 4 }}>Issue</button>
        </form>
      </section>

      <table style={{ width: '100%', borderCollapse: 'collapse', marginTop: 24, fontSize: 14 }}>
        <thead style={{ textAlign: 'left', borderBottom: '1px solid #d7dce4' }}>
          <tr>
            <th style={{ padding: 8 }}>Key</th>
            <th style={{ padding: 8 }}>Name</th>
            <th style={{ padding: 8 }}>Scope</th>
            <th style={{ padding: 8 }}>Status</th>
            <th style={{ padding: 8 }}>Issued</th>
            <th style={{ padding: 8 }}>Last used</th>
            <th style={{ padding: 8 }}></th>
          </tr>
        </thead>
        <tbody>
          {keys.length === 0 && <tr><td colSpan={7} style={{ padding: 12, color: '#9aa3b2' }}>No keys.</td></tr>}
          {keys.map((k) => (
            <tr key={k.key_id} style={{ borderBottom: '1px solid #eef0f4' }}>
              <td style={{ padding: 8, fontFamily: 'monospace', fontSize: 11 }}>{k.key_id}</td>
              <td style={{ padding: 8 }}>{k.name}</td>
              <td style={{ padding: 8, fontSize: 12 }}>{k.scope}</td>
              <td style={{ padding: 8, color: k.status === 'active' ? '#0d8a3d' : '#a31818', fontWeight: 600 }}>{k.status}</td>
              <td style={{ padding: 8, fontSize: 12, color: '#5a6573' }}>{new Date(k.issued_at).toLocaleString()}</td>
              <td style={{ padding: 8, fontSize: 12, color: '#5a6573' }}>{k.last_used_at ? new Date(k.last_used_at).toLocaleString() : '—'}</td>
              <td style={{ padding: 8 }}>
                {k.status === 'active' && (
                  <form action={revokeKey} style={{ display: 'flex', gap: 4 }}>
                    <input type="hidden" name="key_id" value={k.key_id} />
                    <input name="reason" placeholder="reason" required minLength={4} style={{ padding: 2, width: 140 }} />
                    <button type="submit" style={{ padding: '2px 8px', color: '#a31818' }}>Revoke</button>
                  </form>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
