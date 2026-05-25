import { revalidatePath } from 'next/cache';

interface PurposeRow {
  purpose_id: string;
  name: string;
  description: string | null;
  retention_class: string;
  jurisdictions: string[] | null;
}

interface ReceiptRow {
  receipt_id: string;
  subject_persona_id: string;
  purpose_id: string;
  status: string;
  granted_at: string;
  revoked_at: string | null;
}

const TENANT_ID = process.env.TENANT_ADMIN_TENANT_ID ?? '';

async function fetchPurposes(): Promise<PurposeRow[]> {
  if (!TENANT_ID) return [];
  try {
    const res = await fetch(
      `${process.env.NEXT_PUBLIC_GATEWAY_URL}/api/consent/purposes?tenant_id=${encodeURIComponent(TENANT_ID)}`,
      { cache: 'no-store' },
    );
    if (!res.ok) return [];
    return (await res.json()).data ?? [];
  } catch { return []; }
}

async function fetchReceipts(q: { subject_persona_id?: string; purpose_id?: string }): Promise<ReceiptRow[]> {
  if (!TENANT_ID) return [];
  const qs = new URLSearchParams({ tenant_id: TENANT_ID });
  if (q.subject_persona_id) qs.set('subject_persona_id', q.subject_persona_id);
  if (q.purpose_id) qs.set('purpose_id', q.purpose_id);
  try {
    const res = await fetch(
      `${process.env.NEXT_PUBLIC_GATEWAY_URL}/api/consent/receipts?${qs.toString()}`,
      { cache: 'no-store' },
    );
    if (!res.ok) return [];
    return (await res.json()).data ?? [];
  } catch { return []; }
}

async function revokeAction(formData: FormData): Promise<void> {
  'use server';
  const receipt_id = String(formData.get('receipt_id') ?? '');
  await fetch(
    `${process.env.NEXT_PUBLIC_GATEWAY_URL}/api/consent/receipts/${encodeURIComponent(receipt_id)}/revoke`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ reason: String(formData.get('reason') ?? 'tenant-admin revoke') }),
    },
  );
  revalidatePath('/consent');
}

export default async function ConsentPage({
  searchParams,
}: {
  searchParams: { subject_persona_id?: string; purpose_id?: string };
}): Promise<JSX.Element> {
  const [purposes, receipts] = await Promise.all([fetchPurposes(), fetchReceipts(searchParams)]);
  return (
    <div>
      <h1>Consent</h1>
      <p style={{ color: '#5a6573' }}>Consent purposes registered for this tenant + receipts granted under each.</p>

      <h2 style={{ marginTop: 16 }}>Purposes</h2>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 14 }}>
        <thead style={{ textAlign: 'left', borderBottom: '1px solid #d7dce4' }}>
          <tr>
            <th style={{ padding: 8 }}>Purpose</th>
            <th style={{ padding: 8 }}>Name</th>
            <th style={{ padding: 8 }}>Description</th>
            <th style={{ padding: 8 }}>Retention</th>
            <th style={{ padding: 8 }}>Jurisdictions</th>
          </tr>
        </thead>
        <tbody>
          {purposes.length === 0 && <tr><td colSpan={5} style={{ padding: 12, color: '#9aa3b2' }}>No purposes registered.</td></tr>}
          {purposes.map((p) => (
            <tr key={p.purpose_id} style={{ borderBottom: '1px solid #eef0f4' }}>
              <td style={{ padding: 8, fontFamily: 'monospace', fontSize: 11 }}>{p.purpose_id}</td>
              <td style={{ padding: 8 }}>{p.name}</td>
              <td style={{ padding: 8, fontSize: 12, color: '#5a6573' }}>{p.description ?? '—'}</td>
              <td style={{ padding: 8 }}>{p.retention_class}</td>
              <td style={{ padding: 8, fontSize: 12 }}>{p.jurisdictions?.join(', ') ?? '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <h2 style={{ marginTop: 24 }}>Receipts</h2>
      <form method="get" style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
        <input name="subject_persona_id" defaultValue={searchParams.subject_persona_id} placeholder="subject persona_id" style={{ padding: 4, width: 280 }} />
        <input name="purpose_id" defaultValue={searchParams.purpose_id} placeholder="purpose_id" style={{ padding: 4, width: 240 }} />
        <button type="submit" style={{ padding: '4px 12px' }}>Filter</button>
      </form>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 14 }}>
        <thead style={{ textAlign: 'left', borderBottom: '1px solid #d7dce4' }}>
          <tr>
            <th style={{ padding: 8 }}>Receipt</th>
            <th style={{ padding: 8 }}>Subject</th>
            <th style={{ padding: 8 }}>Purpose</th>
            <th style={{ padding: 8 }}>Status</th>
            <th style={{ padding: 8 }}>Granted</th>
            <th style={{ padding: 8 }}></th>
          </tr>
        </thead>
        <tbody>
          {receipts.length === 0 && <tr><td colSpan={6} style={{ padding: 12, color: '#9aa3b2' }}>No receipts.</td></tr>}
          {receipts.map((r) => (
            <tr key={r.receipt_id} style={{ borderBottom: '1px solid #eef0f4' }}>
              <td style={{ padding: 8, fontFamily: 'monospace', fontSize: 11 }}>{r.receipt_id}</td>
              <td style={{ padding: 8, fontFamily: 'monospace', fontSize: 11 }}>{r.subject_persona_id}</td>
              <td style={{ padding: 8, fontSize: 12 }}>{r.purpose_id}</td>
              <td style={{ padding: 8, color: r.status === 'granted' ? '#0d8a3d' : '#a31818', fontWeight: 600 }}>{r.status}</td>
              <td style={{ padding: 8, fontSize: 12, color: '#5a6573' }}>{new Date(r.granted_at).toLocaleString()}</td>
              <td style={{ padding: 8 }}>
                {r.status === 'granted' && (
                  <form action={revokeAction} style={{ display: 'flex', gap: 4 }}>
                    <input type="hidden" name="receipt_id" value={r.receipt_id} />
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
