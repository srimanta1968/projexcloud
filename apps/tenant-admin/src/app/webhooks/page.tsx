import { revalidatePath } from 'next/cache';

interface EndpointRow {
  endpoint_id: string;
  url: string;
  status: string;
  failure_streak: number;
  last_success_at: string | null;
}

interface DlqRow {
  delivery_id: string;
  event_type: string;
  attempts: number;
  failed_at: string;
}

const TENANT_ID = process.env.TENANT_ADMIN_TENANT_ID ?? '';

async function fetchEndpoints(): Promise<EndpointRow[]> {
  if (!TENANT_ID) return [];
  try {
    const res = await fetch(
      `${process.env.NEXT_PUBLIC_GATEWAY_URL}/api/webhooks/endpoints?tenant_id=${encodeURIComponent(TENANT_ID)}`,
      { cache: 'no-store' },
    );
    if (!res.ok) return [];
    return (await res.json()).data ?? [];
  } catch { return []; }
}

async function fetchDlq(): Promise<DlqRow[]> {
  try {
    const res = await fetch(`${process.env.NEXT_PUBLIC_GATEWAY_URL}/api/webhooks/dlq`, { cache: 'no-store' });
    if (!res.ok) return [];
    return (await res.json()).data ?? [];
  } catch { return []; }
}

async function registerAction(formData: FormData): Promise<void> {
  'use server';
  await fetch(`${process.env.NEXT_PUBLIC_GATEWAY_URL}/api/webhooks/endpoints`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      tenant_id: TENANT_ID,
      url: String(formData.get('url') ?? ''),
      signing_key_ref: String(formData.get('signing_key_ref') ?? ''),
    }),
  });
  revalidatePath('/webhooks');
}

export default async function WebhooksPage(): Promise<JSX.Element> {
  const [endpoints, dlq] = await Promise.all([fetchEndpoints(), fetchDlq()]);
  return (
    <div>
      <h1>Webhooks</h1>

      <section style={{ marginTop: 16, padding: 16, border: '1px solid #d7dce4', borderRadius: 8, maxWidth: 720 }}>
        <h2 style={{ marginTop: 0 }}>Register endpoint</h2>
        <form action={registerAction} style={{ display: 'grid', gap: 12 }}>
          <label>URL (https://…) <input name="url" required type="url" style={{ display: 'block', width: '100%', padding: 6 }} /></label>
          <label>Signing key ref <input name="signing_key_ref" required style={{ display: 'block', width: '100%', padding: 6 }} placeholder="vault:hmac/webhook-default" /></label>
          <button type="submit" style={{ padding: '8px 16px', background: '#1b2a44', color: 'white', border: 'none', borderRadius: 4 }}>Register</button>
        </form>
        <p style={{ fontSize: 12, color: '#5a6573', marginTop: 8 }}>
          On-prem strict-mode tenants: only in-cluster URLs accepted (FR-ONP-6).
        </p>
      </section>

      <h2 style={{ marginTop: 24 }}>Endpoints</h2>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 14 }}>
        <thead style={{ textAlign: 'left', borderBottom: '1px solid #d7dce4' }}>
          <tr>
            <th style={{ padding: 8 }}>Endpoint</th>
            <th style={{ padding: 8 }}>URL</th>
            <th style={{ padding: 8 }}>Status</th>
            <th style={{ padding: 8, textAlign: 'right' }}>Failures</th>
            <th style={{ padding: 8 }}>Last success</th>
          </tr>
        </thead>
        <tbody>
          {endpoints.length === 0 && <tr><td colSpan={5} style={{ padding: 12, color: '#9aa3b2' }}>No endpoints.</td></tr>}
          {endpoints.map((e) => (
            <tr key={e.endpoint_id} style={{ borderBottom: '1px solid #eef0f4' }}>
              <td style={{ padding: 8, fontFamily: 'monospace', fontSize: 11 }}>{e.endpoint_id}</td>
              <td style={{ padding: 8, fontSize: 12, wordBreak: 'break-all' }}>{e.url}</td>
              <td style={{ padding: 8 }}>{e.status}</td>
              <td style={{ padding: 8, textAlign: 'right' }}>{e.failure_streak}</td>
              <td style={{ padding: 8, fontSize: 12, color: '#5a6573' }}>
                {e.last_success_at ? new Date(e.last_success_at).toLocaleString() : '—'}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <h2 style={{ marginTop: 24 }}>DLQ</h2>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 14 }}>
        <thead style={{ textAlign: 'left', borderBottom: '1px solid #d7dce4' }}>
          <tr>
            <th style={{ padding: 8 }}>Delivery</th>
            <th style={{ padding: 8 }}>Event type</th>
            <th style={{ padding: 8, textAlign: 'right' }}>Attempts</th>
            <th style={{ padding: 8 }}>Failed at</th>
          </tr>
        </thead>
        <tbody>
          {dlq.length === 0 && <tr><td colSpan={4} style={{ padding: 12, color: '#9aa3b2' }}>DLQ empty.</td></tr>}
          {dlq.map((d) => (
            <tr key={d.delivery_id} style={{ borderBottom: '1px solid #eef0f4' }}>
              <td style={{ padding: 8, fontFamily: 'monospace', fontSize: 11 }}>{d.delivery_id}</td>
              <td style={{ padding: 8, fontFamily: 'monospace', fontSize: 12 }}>{d.event_type}</td>
              <td style={{ padding: 8, textAlign: 'right' }}>{d.attempts}</td>
              <td style={{ padding: 8, fontSize: 12, color: '#5a6573' }}>{new Date(d.failed_at).toLocaleString()}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
