import { revalidatePath } from 'next/cache';
import Link from 'next/link';

interface PoolDetail {
  pool: {
    pool_index: string;
    region: string;
    isolation_class: string;
    status: string;
    replication_role: string | null;
    replicates_from_pool_index: string | null;
    created_at: string;
    updated_at: string;
  };
  tenant_count: number;
  lifecycle_history: Array<{
    to_status: string;
    reason: string | null;
    occurred_at: string;
    operator_id: string;
  }>;
}

async function fetchDetail(poolIndex: string): Promise<PoolDetail | null> {
  try {
    const res = await fetch(
      `${process.env.NEXT_PUBLIC_GATEWAY_URL}/admin/pools/${encodeURIComponent(poolIndex)}`,
      {
        cache: 'no-store',
        headers: { 'x-admin-ops-token': process.env.ADMIN_OPS_TOKEN ?? '' },
      },
    );
    if (!res.ok) return null;
    return (await res.json()).data ?? null;
  } catch { return null; }
}

async function flipStatus(formData: FormData): Promise<void> {
  'use server';
  const pool_index = String(formData.get('pool_index') ?? '');
  await fetch(
    `${process.env.NEXT_PUBLIC_GATEWAY_URL}/admin/pools/${encodeURIComponent(pool_index)}/status`,
    {
      method: 'PATCH',
      headers: {
        'content-type': 'application/json',
        'x-admin-ops-token': process.env.ADMIN_OPS_TOKEN ?? '',
      },
      body: JSON.stringify({
        to_status: String(formData.get('to_status') ?? ''),
        reason: String(formData.get('reason') ?? ''),
        operator_id: 'admin-ui',
      }),
    },
  );
  revalidatePath(`/pools/${pool_index}`);
}

export default async function PoolDetailPage({ params }: { params: { pool_index: string } }): Promise<JSX.Element> {
  const d = await fetchDetail(params.pool_index);
  if (!d) {
    return (
      <div>
        <Link href="/pools">← Back</Link>
        <h1>Pool not found</h1>
      </div>
    );
  }
  return (
    <div>
      <Link href="/pools">← Back to pools</Link>
      <h1 style={{ fontFamily: 'monospace' }}>{d.pool.pool_index}</h1>
      <dl style={{ display: 'grid', gridTemplateColumns: '180px 1fr', gap: '6px 12px', fontSize: 14 }}>
        <dt style={{ color: '#5a6573' }}>Region</dt><dd style={{ margin: 0 }}>{d.pool.region}</dd>
        <dt style={{ color: '#5a6573' }}>Capacity</dt><dd style={{ margin: 0 }}>{d.pool.isolation_class}</dd>
        <dt style={{ color: '#5a6573' }}>Status</dt><dd style={{ margin: 0, fontWeight: 600 }}>{d.pool.status}</dd>
        <dt style={{ color: '#5a6573' }}>Replication role</dt><dd style={{ margin: 0 }}>{d.pool.replication_role ?? '—'}</dd>
        <dt style={{ color: '#5a6573' }}>Replicates from</dt><dd style={{ margin: 0, fontFamily: 'monospace' }}>{d.pool.replicates_from_pool_index ?? '—'}</dd>
        <dt style={{ color: '#5a6573' }}>Tenants</dt><dd style={{ margin: 0 }}>{d.tenant_count}</dd>
        <dt style={{ color: '#5a6573' }}>Created</dt><dd style={{ margin: 0 }}>{new Date(d.pool.created_at).toLocaleString()}</dd>
      </dl>

      <h2 style={{ marginTop: 24 }}>Flip status</h2>
      <form action={flipStatus} style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <input type="hidden" name="pool_index" value={d.pool.pool_index} />
        <select name="to_status" defaultValue={d.pool.status} style={{ padding: 4 }}>
          <option value="active">active</option>
          <option value="draining">draining</option>
          <option value="quiesced">quiesced</option>
          <option value="retired">retired</option>
        </select>
        <input name="reason" placeholder="reason (required)" required minLength={4} style={{ padding: 4, flex: 1 }} />
        <button type="submit" style={{ padding: '6px 16px' }}>Apply</button>
      </form>

      <h2 style={{ marginTop: 24 }}>Lifecycle history</h2>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 14 }}>
        <thead style={{ textAlign: 'left', borderBottom: '1px solid #d7dce4' }}>
          <tr>
            <th style={{ padding: 6 }}>When</th>
            <th style={{ padding: 6 }}>To status</th>
            <th style={{ padding: 6 }}>Reason</th>
            <th style={{ padding: 6 }}>Operator</th>
          </tr>
        </thead>
        <tbody>
          {d.lifecycle_history.length === 0 && <tr><td colSpan={4} style={{ padding: 12, color: '#9aa3b2' }}>No history yet.</td></tr>}
          {d.lifecycle_history.map((e, i) => (
            <tr key={i} style={{ borderBottom: '1px solid #eef0f4' }}>
              <td style={{ padding: 6 }}>{new Date(e.occurred_at).toLocaleString()}</td>
              <td style={{ padding: 6 }}>{e.to_status}</td>
              <td style={{ padding: 6, color: '#5a6573' }}>{e.reason ?? '—'}</td>
              <td style={{ padding: 6 }}>{e.operator_id}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
