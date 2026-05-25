import { revalidatePath } from 'next/cache';
import Link from 'next/link';

interface BreachRow {
  request_id: string;
  tenant_id: string;
  route_id: string;
  subject_ref: string;
  created_at: string;
  status: string;
  elapsed_minutes: number;
  sla_minutes: number;
}

async function fetchBreaches(): Promise<BreachRow[]> {
  try {
    const res = await fetch(`${process.env.NEXT_PUBLIC_GATEWAY_URL}/admin/approvals/breaches`, {
      cache: 'no-store',
      headers: { 'x-admin-ops-token': process.env.ADMIN_OPS_TOKEN ?? '' },
    });
    if (!res.ok) return [];
    return (await res.json()).data ?? [];
  } catch { return []; }
}

async function overrideAction(formData: FormData): Promise<void> {
  'use server';
  const request_id = String(formData.get('request_id') ?? '');
  await fetch(
    `${process.env.NEXT_PUBLIC_GATEWAY_URL}/admin/approvals/requests/${encodeURIComponent(request_id)}/operator-override`,
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-admin-ops-token': process.env.ADMIN_OPS_TOKEN ?? '',
      },
      body: JSON.stringify({
        decision: String(formData.get('decision') ?? 'rejected'),
        reason: String(formData.get('reason') ?? ''),
        operator_id: 'admin-ui',
      }),
    },
  );
  revalidatePath('/approvals/breaches');
}

export default async function BreachesPage(): Promise<JSX.Element> {
  const rows = await fetchBreaches();
  return (
    <div>
      <Link href="/approvals">← Routes</Link>
      <h1>SLA breaches</h1>
      <p style={{ color: '#5a6573' }}>Pending requests past their SLA. Operator override requires a written reason.</p>
      <table style={{ width: '100%', borderCollapse: 'collapse', marginTop: 16, fontSize: 14 }}>
        <thead style={{ textAlign: 'left', borderBottom: '1px solid #d7dce4' }}>
          <tr>
            <th style={{ padding: 8 }}>Request</th>
            <th style={{ padding: 8 }}>Subject</th>
            <th style={{ padding: 8, textAlign: 'right' }}>Elapsed (min)</th>
            <th style={{ padding: 8, textAlign: 'right' }}>SLA</th>
            <th style={{ padding: 8 }}>Override</th>
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 && <tr><td colSpan={5} style={{ padding: 12, color: '#9aa3b2' }}>No SLA breaches. 🎉</td></tr>}
          {rows.map((r) => (
            <tr key={r.request_id} style={{ borderBottom: '1px solid #eef0f4' }}>
              <td style={{ padding: 8, fontFamily: 'monospace', fontSize: 12 }}>{r.request_id}</td>
              <td style={{ padding: 8, fontFamily: 'monospace', fontSize: 12 }}>{r.subject_ref}</td>
              <td style={{ padding: 8, textAlign: 'right', color: '#a31818', fontWeight: 600 }}>{Math.round(r.elapsed_minutes)}</td>
              <td style={{ padding: 8, textAlign: 'right' }}>{r.sla_minutes}</td>
              <td style={{ padding: 8 }}>
                <form action={overrideAction} style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
                  <input type="hidden" name="request_id" value={r.request_id} />
                  <select name="decision" style={{ padding: 4 }}>
                    <option value="approved">approve</option>
                    <option value="rejected">reject</option>
                  </select>
                  <input name="reason" placeholder="reason" required minLength={4} style={{ padding: 4, width: 200 }} />
                  <button type="submit" style={{ padding: '4px 10px' }}>Override</button>
                </form>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
