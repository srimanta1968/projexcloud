import Link from 'next/link';

interface EndpointRow {
  endpoint_id: string;
  tenant_id: string;
  url: string;
  status: string;
  failure_streak: number;
  last_success_at: string | null;
  last_failure_at: string | null;
}

async function fetchEndpoints(): Promise<EndpointRow[]> {
  try {
    const res = await fetch(`${process.env.NEXT_PUBLIC_GATEWAY_URL}/admin/webhooks`, {
      cache: 'no-store',
      headers: { 'x-admin-ops-token': process.env.ADMIN_OPS_TOKEN ?? '' },
    });
    if (!res.ok) return [];
    return (await res.json()).data ?? [];
  } catch { return []; }
}

export default async function WebhooksPage(): Promise<JSX.Element> {
  const endpoints = await fetchEndpoints();
  return (
    <div>
      <h1>Webhooks</h1>
      <p style={{ color: '#5a6573' }}>
        Cross-tenant endpoint view. Use the <Link href="/webhooks/dlq">DLQ</Link> page to replay failed deliveries.
      </p>
      <table style={{ width: '100%', borderCollapse: 'collapse', marginTop: 16 }}>
        <thead style={{ textAlign: 'left', borderBottom: '1px solid #d7dce4' }}>
          <tr>
            <th style={{ padding: 8 }}>Endpoint</th>
            <th style={{ padding: 8 }}>Tenant</th>
            <th style={{ padding: 8 }}>URL</th>
            <th style={{ padding: 8 }}>Status</th>
            <th style={{ padding: 8, textAlign: 'right' }}>Fail streak</th>
          </tr>
        </thead>
        <tbody>
          {endpoints.length === 0 && <tr><td colSpan={5} style={{ padding: 12, color: '#9aa3b2' }}>No endpoints.</td></tr>}
          {endpoints.map((e) => (
            <tr key={e.endpoint_id} style={{ borderBottom: '1px solid #eef0f4' }}>
              <td style={{ padding: 8, fontFamily: 'monospace', fontSize: 12 }}>{e.endpoint_id}</td>
              <td style={{ padding: 8, fontFamily: 'monospace', fontSize: 12 }}>{e.tenant_id}</td>
              <td style={{ padding: 8, fontSize: 12, wordBreak: 'break-all' }}>{e.url}</td>
              <td style={{ padding: 8, color: e.status === 'active' ? '#0d8a3d' : '#a31818', fontWeight: 600 }}>{e.status}</td>
              <td style={{ padding: 8, textAlign: 'right' }}>{e.failure_streak}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
