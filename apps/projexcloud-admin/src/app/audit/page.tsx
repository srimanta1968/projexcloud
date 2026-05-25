import { revalidatePath } from 'next/cache';

interface EntryRow {
  entry_id: string;
  tenant_id: string;
  actor_kind: string;
  actor_id: string;
  action: string;
  occurred_at: string;
  seq: number;
}

async function fetchEntries(q: { tenant_id?: string; actor_id?: string; from?: string; to?: string }): Promise<EntryRow[]> {
  const qs = new URLSearchParams();
  if (q.tenant_id) qs.set('tenant_id', q.tenant_id);
  if (q.actor_id) qs.set('actor_id', q.actor_id);
  if (q.from) qs.set('from', q.from);
  if (q.to) qs.set('to', q.to);
  try {
    const res = await fetch(
      `${process.env.NEXT_PUBLIC_GATEWAY_URL}/admin/audit/entries?${qs.toString()}`,
      { cache: 'no-store', headers: { 'x-admin-ops-token': process.env.ADMIN_OPS_TOKEN ?? '' } },
    );
    if (!res.ok) return [];
    return (await res.json()).data ?? [];
  } catch { return []; }
}

async function verifyAction(formData: FormData): Promise<void> {
  'use server';
  const tenant_id = String(formData.get('tenant_id') ?? '');
  if (!tenant_id) return;
  await fetch(
    `${process.env.NEXT_PUBLIC_GATEWAY_URL}/admin/audit/verify?tenant_id=${encodeURIComponent(tenant_id)}`,
    {
      method: 'POST',
      headers: { 'x-admin-ops-token': process.env.ADMIN_OPS_TOKEN ?? '' },
    },
  );
  revalidatePath('/audit');
}

export default async function AuditPage({
  searchParams,
}: {
  searchParams: { tenant_id?: string; actor_id?: string; from?: string; to?: string };
}): Promise<JSX.Element> {
  const entries = await fetchEntries(searchParams);
  return (
    <div>
      <h1>Audit hash-chain browser</h1>
      <p style={{ color: '#5a6573' }}>Filter and verify the per-tenant audit chain. Gap or hash-mismatch returns the failing seq.</p>

      <form method="get" style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 16, flexWrap: 'wrap' }}>
        <input name="tenant_id" defaultValue={searchParams.tenant_id} placeholder="tenant_id (UUID)" style={{ padding: 4, width: 320 }} />
        <input name="actor_id" defaultValue={searchParams.actor_id} placeholder="actor_id" style={{ padding: 4, width: 200 }} />
        <input name="from" type="datetime-local" defaultValue={searchParams.from} style={{ padding: 4 }} />
        <input name="to" type="datetime-local" defaultValue={searchParams.to} style={{ padding: 4 }} />
        <button type="submit" style={{ padding: '4px 12px' }}>Filter</button>
      </form>

      {searchParams.tenant_id && (
        <form action={verifyAction} style={{ marginTop: 12 }}>
          <input type="hidden" name="tenant_id" value={searchParams.tenant_id} />
          <button type="submit" style={{ padding: '6px 16px', background: '#0b1220', color: 'white', border: 'none', borderRadius: 4 }}>
            Verify chain for this tenant
          </button>
        </form>
      )}

      <table style={{ width: '100%', borderCollapse: 'collapse', marginTop: 16, fontSize: 13 }}>
        <thead style={{ textAlign: 'left', borderBottom: '1px solid #d7dce4' }}>
          <tr>
            <th style={{ padding: 6 }}>Entry</th>
            <th style={{ padding: 6, textAlign: 'right' }}>Seq</th>
            <th style={{ padding: 6 }}>When</th>
            <th style={{ padding: 6 }}>Actor</th>
            <th style={{ padding: 6 }}>Action</th>
          </tr>
        </thead>
        <tbody>
          {entries.length === 0 && <tr><td colSpan={5} style={{ padding: 12, color: '#9aa3b2' }}>No entries match.</td></tr>}
          {entries.map((e) => (
            <tr key={e.entry_id} style={{ borderBottom: '1px solid #eef0f4' }}>
              <td style={{ padding: 6, fontFamily: 'monospace', fontSize: 11 }}>{e.entry_id}</td>
              <td style={{ padding: 6, textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{e.seq}</td>
              <td style={{ padding: 6, color: '#5a6573' }}>{new Date(e.occurred_at).toLocaleString()}</td>
              <td style={{ padding: 6, fontSize: 12 }}>{e.actor_kind}:{e.actor_id}</td>
              <td style={{ padding: 6, fontFamily: 'monospace', fontSize: 12 }}>{e.action}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
