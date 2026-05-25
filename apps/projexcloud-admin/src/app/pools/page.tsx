import Link from 'next/link';

interface PoolRow {
  pool_index: string;
  region: string;
  isolation_class: string;
  status: string;
  replication_role: string | null;
  replicates_from_pool_index: string | null;
}

async function fetchPools(): Promise<PoolRow[]> {
  try {
    const res = await fetch(`${process.env.NEXT_PUBLIC_GATEWAY_URL}/admin/pools`, {
      cache: 'no-store',
      headers: { 'x-admin-ops-token': process.env.ADMIN_OPS_TOKEN ?? '' },
    });
    if (!res.ok) return [];
    return (await res.json()).data ?? [];
  } catch { return []; }
}

function statusColor(s: string): string {
  return s === 'active' ? '#0d8a3d' : s === 'draining' ? '#a36500' : s === 'retired' ? '#7a7a7a' : '#a31818';
}

export default async function PoolsPage(): Promise<JSX.Element> {
  const pools = await fetchPools();
  return (
    <div>
      <h1>Pools</h1>
      <p style={{ color: '#5a6573' }}>Routing pool registry. Status flips emit pool.lifecycle.changed.v1.</p>
      <table style={{ width: '100%', borderCollapse: 'collapse', marginTop: 16 }}>
        <thead style={{ textAlign: 'left', borderBottom: '1px solid #d7dce4' }}>
          <tr>
            <th style={{ padding: 8 }}>Pool</th>
            <th style={{ padding: 8 }}>Region</th>
            <th style={{ padding: 8 }}>Capacity</th>
            <th style={{ padding: 8 }}>Status</th>
            <th style={{ padding: 8 }}>Replication</th>
          </tr>
        </thead>
        <tbody>
          {pools.length === 0 && <tr><td colSpan={5} style={{ padding: 12, color: '#9aa3b2' }}>No pools registered.</td></tr>}
          {pools.map((p) => (
            <tr key={p.pool_index} style={{ borderBottom: '1px solid #eef0f4' }}>
              <td style={{ padding: 8, fontFamily: 'monospace' }}>
                <Link href={`/pools/${encodeURIComponent(p.pool_index)}`}>{p.pool_index}</Link>
              </td>
              <td style={{ padding: 8 }}>{p.region}</td>
              <td style={{ padding: 8 }}>{p.isolation_class}</td>
              <td style={{ padding: 8, color: statusColor(p.status), fontWeight: 600 }}>{p.status}</td>
              <td style={{ padding: 8, color: '#5a6573' }}>
                {p.replication_role ?? '—'}
                {p.replicates_from_pool_index ? ` ← ${p.replicates_from_pool_index}` : ''}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
