import Link from 'next/link';

interface CatalogRow {
  catalog_id: string;
  version: number;
  status: 'draft' | 'active' | 'retired';
  effective_from: string;
  effective_to: string | null;
  created_by: string;
  rate_count: number;
}

async function fetchCatalogs(): Promise<CatalogRow[]> {
  try {
    const res = await fetch(
      `${process.env.NEXT_PUBLIC_GATEWAY_URL}/admin/meter/pricing-catalogs`,
      {
        cache: 'no-store',
        headers: { 'x-admin-ops-token': process.env.ADMIN_OPS_TOKEN ?? '' },
      },
    );
    if (!res.ok) return [];
    const body = await res.json();
    return body.data ?? [];
  } catch {
    return [];
  }
}

function statusColor(status: string): string {
  switch (status) {
    case 'active':
      return '#0d8a3d';
    case 'draft':
      return '#a36500';
    case 'retired':
      return '#7a7a7a';
    default:
      return '#000';
  }
}

export default async function PricingCatalogsPage(): Promise<JSX.Element> {
  const catalogs = await fetchCatalogs();
  return (
    <div>
      <h1>Pricing catalogs</h1>
      <p style={{ color: '#5a6573' }}>
        Versioned rate cards consumed by the meter gate. Each catalog is immutable once
        retired; create a new version to roll prices forward. Sample defaults were seeded
        by migration <code>005_p7_skus.sql</code>; override here per the doctrine.
      </p>
      <table style={{ width: '100%', borderCollapse: 'collapse', marginTop: 16 }}>
        <thead style={{ textAlign: 'left', borderBottom: '1px solid #d7dce4' }}>
          <tr>
            <th style={{ padding: 8 }}>Catalog</th>
            <th style={{ padding: 8 }}>Version</th>
            <th style={{ padding: 8 }}>Status</th>
            <th style={{ padding: 8 }}>Effective From</th>
            <th style={{ padding: 8 }}>Rates</th>
            <th style={{ padding: 8 }}>Created by</th>
          </tr>
        </thead>
        <tbody>
          {catalogs.length === 0 && (
            <tr>
              <td colSpan={6} style={{ padding: 12, color: '#9aa3b2' }}>
                No catalogs visible. Make sure the gateway is up and ADMIN_OPS_TOKEN is set
                in this app&apos;s env.
              </td>
            </tr>
          )}
          {catalogs.map((c) => (
            <tr key={c.catalog_id} style={{ borderBottom: '1px solid #eef0f4' }}>
              <td style={{ padding: 8, fontFamily: 'monospace' }}>
                <Link href={`/pricing-catalogs/${encodeURIComponent(c.catalog_id)}`}>
                  {c.catalog_id}
                </Link>
              </td>
              <td style={{ padding: 8 }}>{c.version}</td>
              <td style={{ padding: 8, color: statusColor(c.status), fontWeight: 600 }}>
                {c.status}
              </td>
              <td style={{ padding: 8 }}>{new Date(c.effective_from).toLocaleString()}</td>
              <td style={{ padding: 8 }}>{c.rate_count}</td>
              <td style={{ padding: 8, color: '#5a6573' }}>{c.created_by}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
