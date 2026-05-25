import Link from 'next/link';

interface TenantRow {
  tenant_id: string;
  display_name: string;
  app_id: string;
  region: string;
  isolation_tier: string;
  status: string;
  created_at: string;
}

async function fetchTenants(): Promise<TenantRow[]> {
  try {
    const res = await fetch(
      `${process.env.NEXT_PUBLIC_GATEWAY_URL}/admin/tenants`,
      {
        cache: 'no-store',
        headers: { 'x-admin-ops-token': process.env.ADMIN_OPS_TOKEN ?? '' },
      },
    );
    if (!res.ok) return [];
    const body = await res.json();
    return body.data?.tenants ?? [];
  } catch {
    return [];
  }
}

export default async function TenantsPage(): Promise<JSX.Element> {
  const tenants = await fetchTenants();
  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between' }}>
        <h1 style={{ margin: 0 }}>Tenants</h1>
        <Link
          href="/tenants/new"
          style={{
            background: '#0b1220', color: '#fff', padding: '8px 14px',
            borderRadius: 6, textDecoration: 'none', fontSize: 14,
          }}
        >
          + New tenant
        </Link>
      </div>
      <p style={{ color: '#5a6573' }}>
        Lifecycle state per tenant. Each row links to per-tenant actions
        (suspend, reinstate, offboard) under the Tenant Lifecycle SDK.
      </p>
      <table style={{ width: '100%', borderCollapse: 'collapse', marginTop: 16 }}>
        <thead style={{ textAlign: 'left', borderBottom: '1px solid #d7dce4' }}>
          <tr>
            <th style={{ padding: 8 }}>Tenant ID</th>
            <th style={{ padding: 8 }}>Display name</th>
            <th style={{ padding: 8 }}>App</th>
            <th style={{ padding: 8 }}>Region</th>
            <th style={{ padding: 8 }}>Tier</th>
            <th style={{ padding: 8 }}>Status</th>
          </tr>
        </thead>
        <tbody>
          {tenants.length === 0 && (
            <tr><td colSpan={6} style={{ padding: 12, color: '#9aa3b2' }}>
              No tenants yet. Click <strong>+ New tenant</strong> to provision the first one.
              If you expected rows, check that the gateway is reachable at <code>{process.env.NEXT_PUBLIC_GATEWAY_URL}</code> and that <code>ADMIN_OPS_TOKEN</code> matches between the gateway and this app.
            </td></tr>
          )}
          {tenants.map((t) => (
            <tr key={t.tenant_id} style={{ borderBottom: '1px solid #eef0f4' }}>
              <td style={{ padding: 8, fontFamily: 'monospace', fontSize: 12 }}>{t.tenant_id}</td>
              <td style={{ padding: 8 }}>{t.display_name}</td>
              <td style={{ padding: 8, fontFamily: 'monospace', fontSize: 12 }}>{t.app_id}</td>
              <td style={{ padding: 8 }}>{t.region}</td>
              <td style={{ padding: 8 }}>{t.isolation_tier}</td>
              <td style={{ padding: 8 }}>{t.status}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
