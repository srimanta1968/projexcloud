import { revalidatePath } from 'next/cache';

interface RouteRow {
  route_id: string;
  name: string;
  sla_minutes: number;
  created_at: string;
}

interface RequestRow {
  request_id: string;
  route_id: string;
  subject_ref: string;
  status: string;
  created_at: string;
}

const TENANT_ID = process.env.TENANT_ADMIN_TENANT_ID ?? '';
const SELF_PERSONA = process.env.TENANT_ADMIN_PERSONA_ID ?? '';

async function fetchRoutes(): Promise<RouteRow[]> {
  if (!TENANT_ID) return [];
  try {
    const res = await fetch(
      `${process.env.NEXT_PUBLIC_GATEWAY_URL}/api/approvals/routes?tenant_id=${encodeURIComponent(TENANT_ID)}`,
      { cache: 'no-store' },
    );
    if (!res.ok) return [];
    return (await res.json()).data ?? [];
  } catch { return []; }
}

async function fetchMyPending(): Promise<RequestRow[]> {
  if (!TENANT_ID || !SELF_PERSONA) return [];
  try {
    const res = await fetch(
      `${process.env.NEXT_PUBLIC_GATEWAY_URL}/api/approvals/requests?tenant_id=${encodeURIComponent(TENANT_ID)}&assignee_persona_id=${encodeURIComponent(SELF_PERSONA)}`,
      { cache: 'no-store' },
    );
    if (!res.ok) return [];
    return (await res.json()).data ?? [];
  } catch { return []; }
}

async function decideAction(formData: FormData): Promise<void> {
  'use server';
  const request_id = String(formData.get('request_id') ?? '');
  await fetch(
    `${process.env.NEXT_PUBLIC_GATEWAY_URL}/api/approvals/requests/${encodeURIComponent(request_id)}/decide`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        decision: String(formData.get('decision') ?? 'rejected'),
        comment: String(formData.get('comment') ?? ''),
        decider_persona_id: SELF_PERSONA,
      }),
    },
  );
  revalidatePath('/approvals');
}

export default async function ApprovalsPage(): Promise<JSX.Element> {
  const [routes, pending] = await Promise.all([fetchRoutes(), fetchMyPending()]);
  return (
    <div>
      <h1>Approvals</h1>

      <h2>My pending decisions</h2>
      {!SELF_PERSONA && (
        <div style={{ background: '#fff4d6', border: '1px solid #e3c47b', padding: 8, marginBottom: 12, fontSize: 13 }}>
          Set <code>TENANT_ADMIN_PERSONA_ID</code> to see decisions assigned to you.
        </div>
      )}
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 14 }}>
        <thead style={{ textAlign: 'left', borderBottom: '1px solid #d7dce4' }}>
          <tr>
            <th style={{ padding: 8 }}>Request</th>
            <th style={{ padding: 8 }}>Subject</th>
            <th style={{ padding: 8 }}>Created</th>
            <th style={{ padding: 8 }}>Decide</th>
          </tr>
        </thead>
        <tbody>
          {pending.length === 0 && <tr><td colSpan={4} style={{ padding: 12, color: '#9aa3b2' }}>No pending decisions.</td></tr>}
          {pending.map((r) => (
            <tr key={r.request_id} style={{ borderBottom: '1px solid #eef0f4' }}>
              <td style={{ padding: 8, fontFamily: 'monospace', fontSize: 11 }}>{r.request_id}</td>
              <td style={{ padding: 8, fontFamily: 'monospace', fontSize: 12 }}>{r.subject_ref}</td>
              <td style={{ padding: 8, fontSize: 12, color: '#5a6573' }}>{new Date(r.created_at).toLocaleString()}</td>
              <td style={{ padding: 8 }}>
                <form action={decideAction} style={{ display: 'flex', gap: 4 }}>
                  <input type="hidden" name="request_id" value={r.request_id} />
                  <select name="decision" style={{ padding: 4 }}>
                    <option value="approved">approve</option>
                    <option value="rejected">reject</option>
                  </select>
                  <input name="comment" placeholder="comment" required minLength={4} style={{ padding: 4, width: 240 }} />
                  <button type="submit" style={{ padding: '4px 12px' }}>Decide</button>
                </form>
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <h2 style={{ marginTop: 24 }}>Routes</h2>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 14 }}>
        <thead style={{ textAlign: 'left', borderBottom: '1px solid #d7dce4' }}>
          <tr>
            <th style={{ padding: 8 }}>Route</th>
            <th style={{ padding: 8 }}>Name</th>
            <th style={{ padding: 8, textAlign: 'right' }}>SLA (min)</th>
            <th style={{ padding: 8 }}>Created</th>
          </tr>
        </thead>
        <tbody>
          {routes.length === 0 && <tr><td colSpan={4} style={{ padding: 12, color: '#9aa3b2' }}>No routes.</td></tr>}
          {routes.map((r) => (
            <tr key={r.route_id} style={{ borderBottom: '1px solid #eef0f4' }}>
              <td style={{ padding: 8, fontFamily: 'monospace', fontSize: 11 }}>{r.route_id}</td>
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
