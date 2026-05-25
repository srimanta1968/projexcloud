import { revalidatePath } from 'next/cache';
import Link from 'next/link';

interface DlqRow {
  delivery_id: string;
  endpoint_id: string;
  event_type: string;
  last_status_code: number | null;
  last_error: string | null;
  attempts: number;
  failed_at: string;
}

async function fetchDlq(): Promise<DlqRow[]> {
  try {
    const res = await fetch(`${process.env.NEXT_PUBLIC_GATEWAY_URL}/admin/webhooks/dlq`, {
      cache: 'no-store',
      headers: { 'x-admin-ops-token': process.env.ADMIN_OPS_TOKEN ?? '' },
    });
    if (!res.ok) return [];
    return (await res.json()).data ?? [];
  } catch { return []; }
}

async function replayAction(formData: FormData): Promise<void> {
  'use server';
  const delivery_id = String(formData.get('delivery_id') ?? '');
  await fetch(
    `${process.env.NEXT_PUBLIC_GATEWAY_URL}/admin/webhooks/dlq/${encodeURIComponent(delivery_id)}/replay`,
    {
      method: 'POST',
      headers: { 'x-admin-ops-token': process.env.ADMIN_OPS_TOKEN ?? '' },
    },
  );
  revalidatePath('/webhooks/dlq');
}

export default async function DlqPage(): Promise<JSX.Element> {
  const rows = await fetchDlq();
  return (
    <div>
      <Link href="/webhooks">← Endpoints</Link>
      <h1>Webhook DLQ</h1>
      <p style={{ color: '#5a6573' }}>Failed deliveries. Replay restores them within the configured window.</p>
      <table style={{ width: '100%', borderCollapse: 'collapse', marginTop: 16 }}>
        <thead style={{ textAlign: 'left', borderBottom: '1px solid #d7dce4' }}>
          <tr>
            <th style={{ padding: 8 }}>Delivery</th>
            <th style={{ padding: 8 }}>Event type</th>
            <th style={{ padding: 8 }}>Last status</th>
            <th style={{ padding: 8, textAlign: 'right' }}>Attempts</th>
            <th style={{ padding: 8 }}>Failed at</th>
            <th style={{ padding: 8 }}></th>
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 && <tr><td colSpan={6} style={{ padding: 12, color: '#9aa3b2' }}>DLQ empty.</td></tr>}
          {rows.map((r) => (
            <tr key={r.delivery_id} style={{ borderBottom: '1px solid #eef0f4' }}>
              <td style={{ padding: 8, fontFamily: 'monospace', fontSize: 12 }}>{r.delivery_id}</td>
              <td style={{ padding: 8, fontFamily: 'monospace', fontSize: 12 }}>{r.event_type}</td>
              <td style={{ padding: 8 }}>{r.last_status_code ?? '—'}</td>
              <td style={{ padding: 8, textAlign: 'right' }}>{r.attempts}</td>
              <td style={{ padding: 8, fontSize: 12, color: '#5a6573' }}>{new Date(r.failed_at).toLocaleString()}</td>
              <td style={{ padding: 8 }}>
                <form action={replayAction}>
                  <input type="hidden" name="delivery_id" value={r.delivery_id} />
                  <button type="submit" style={{ padding: '4px 12px' }}>Replay</button>
                </form>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
