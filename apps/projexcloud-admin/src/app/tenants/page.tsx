async function fetchTenants(): Promise<Array<{ tenant_id: string; name: string; state: string }>> {
  // Operator-scoped GET against the gateway. Returns empty in dev when the
  // backend isn't up so the page still renders the layout.
  try {
    const res = await fetch(
      `${process.env.NEXT_PUBLIC_GATEWAY_URL}/api/tenants`,
      { cache: 'no-store' },
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
      <h1>Tenants</h1>
      <p style={{ color: '#5a6573' }}>
        Lifecycle state per tenant. Click a row to suspend, refresh sandbox, or initiate offboard.
      </p>
      <table style={{ width: '100%', borderCollapse: 'collapse', marginTop: 16 }}>
        <thead style={{ textAlign: 'left', borderBottom: '1px solid #d7dce4' }}>
          <tr>
            <th style={{ padding: 8 }}>Tenant ID</th>
            <th style={{ padding: 8 }}>Name</th>
            <th style={{ padding: 8 }}>State</th>
          </tr>
        </thead>
        <tbody>
          {tenants.length === 0 && (
            <tr><td colSpan={3} style={{ padding: 12, color: '#9aa3b2' }}>No tenants. Start the gateway and seed at least one.</td></tr>
          )}
          {tenants.map((t) => (
            <tr key={t.tenant_id} style={{ borderBottom: '1px solid #eef0f4' }}>
              <td style={{ padding: 8, fontFamily: 'monospace' }}>{t.tenant_id}</td>
              <td style={{ padding: 8 }}>{t.name}</td>
              <td style={{ padding: 8 }}>{t.state}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
