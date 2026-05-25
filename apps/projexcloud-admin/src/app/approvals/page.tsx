import Link from 'next/link';

interface RouteRow {
  route_id: string;
  tenant_id: string;
  name: string;
  sla_minutes: number;
  created_at: string;
}

async function fetchRoutes(): Promise<RouteRow[]> {
  try {
    const res = await fetch(`${process.env.NEXT_PUBLIC_GATEWAY_URL}/admin/approvals/routes`, {
      cache: 'no-store',
      headers: { 'x-admin-ops-token': process.env.ADMIN_OPS_TOKEN ?? '' },
    });
    if (!res.ok) return [];
    return (await res.json()).data ?? [];
  } catch { return []; }
}

export default async function ApprovalsPage(): Promise<JSX.Element> {
  const routes = await fetchRoutes();
  return (
    <div>
      <h1>Approval routes</h1>
      <p style={{ color: '#5a6573' }}>
        Cross-tenant view. See <Link href="/approvals/breaches">SLA breaches</Link> for stuck requests.
      </p>
      <table style={{ width: '100%', borderCollapse: 'collapse', marginTop: 16 }}>
        <thead style={{ textAlign: 'left', borderBottom: '1px solid #d7dce4' }}>
          <tr>
            <th style={{ padding: 8 }}>Route</th>
            <th style={{ padding: 8 }}>Tenant</th>
            <th style={{ padding: 8 }}>Name</th>
            <th style={{ padding: 8, textAlign: 'right' }}>SLA (min)</th>
            <th style={{ padding: 8 }}>Created</th>
          </tr>
        </thead>
        <tbody>
          {routes.length === 0 && <tr><td colSpan={5} style={{ padding: 12, color: '#9aa3b2' }}>No routes registered.</td></tr>}
          {routes.map((r) => (
            <tr key={r.route_id} style={{ borderBottom: '1px solid #eef0f4' }}>
              <td style={{ padding: 8, fontFamily: 'monospace', fontSize: 12 }}>{r.route_id}</td>
              <td style={{ padding: 8, fontFamily: 'monospace', fontSize: 12 }}>{r.tenant_id}</td>
              <td style={{ padding: 8 }}>{r.name}</td>
              <td style={{ padding: 8, textAlign: 'right' }}>{r.sla_minutes}</td>
              <td style={{ padding: 8, fontSize: 12, color: '#5a6573' }}>{new Date(r.created_at).toLocaleString()}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
