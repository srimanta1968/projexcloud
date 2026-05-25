import { revalidatePath } from 'next/cache';

interface MemberRow {
  persona_id: string;
  display_name: string;
  role: string | null;
  bu_id: string | null;
  status: string;
}

const TENANT_ID = process.env.TENANT_ADMIN_TENANT_ID ?? '';

async function fetchMembers(): Promise<MemberRow[]> {
  if (!TENANT_ID) return [];
  try {
    const res = await fetch(
      `${process.env.NEXT_PUBLIC_GATEWAY_URL}/api/personas?tenant_id=${encodeURIComponent(TENANT_ID)}`,
      { cache: 'no-store' },
    );
    if (!res.ok) return [];
    return (await res.json()).data ?? [];
  } catch { return []; }
}

async function updateRole(formData: FormData): Promise<void> {
  'use server';
  const persona_id = String(formData.get('persona_id') ?? '');
  await fetch(
    `${process.env.NEXT_PUBLIC_GATEWAY_URL}/api/personas/${encodeURIComponent(persona_id)}/role`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ role: String(formData.get('role') ?? '') }),
    },
  );
  revalidatePath('/members');
}

async function deactivateAction(formData: FormData): Promise<void> {
  'use server';
  const persona_id = String(formData.get('persona_id') ?? '');
  await fetch(
    `${process.env.NEXT_PUBLIC_GATEWAY_URL}/api/personas/${encodeURIComponent(persona_id)}/deactivate`,
    { method: 'POST' },
  );
  revalidatePath('/members');
}

export default async function MembersPage(): Promise<JSX.Element> {
  const members = await fetchMembers();
  return (
    <div>
      <h1>Members</h1>
      <p style={{ color: '#5a6573' }}>Personas in this tenant. Assign roles + BUs; deactivate to revoke access.</p>

      {!TENANT_ID && (
        <div style={{ background: '#fff4d6', border: '1px solid #e3c47b', padding: 12 }}>
          Set <code>TENANT_ADMIN_TENANT_ID</code> to view members.
        </div>
      )}

      <table style={{ width: '100%', borderCollapse: 'collapse', marginTop: 16, fontSize: 14 }}>
        <thead style={{ textAlign: 'left', borderBottom: '1px solid #d7dce4' }}>
          <tr>
            <th style={{ padding: 8 }}>Persona</th>
            <th style={{ padding: 8 }}>Name</th>
            <th style={{ padding: 8 }}>Role</th>
            <th style={{ padding: 8 }}>BU</th>
            <th style={{ padding: 8 }}>Status</th>
            <th style={{ padding: 8 }}></th>
          </tr>
        </thead>
        <tbody>
          {members.length === 0 && <tr><td colSpan={6} style={{ padding: 12, color: '#9aa3b2' }}>No members.</td></tr>}
          {members.map((m) => (
            <tr key={m.persona_id} style={{ borderBottom: '1px solid #eef0f4' }}>
              <td style={{ padding: 8, fontFamily: 'monospace', fontSize: 11 }}>{m.persona_id}</td>
              <td style={{ padding: 8 }}>{m.display_name}</td>
              <td style={{ padding: 8 }}>
                <form action={updateRole}>
                  <input type="hidden" name="persona_id" value={m.persona_id} />
                  <input name="role" defaultValue={m.role ?? ''} placeholder="role" style={{ padding: 2, width: 140 }} />
                  <button type="submit" style={{ marginLeft: 4, padding: '2px 8px' }}>Save</button>
                </form>
              </td>
              <td style={{ padding: 8, color: '#5a6573' }}>{m.bu_id ?? '—'}</td>
              <td style={{ padding: 8 }}>{m.status}</td>
              <td style={{ padding: 8 }}>
                {m.status === 'active' && (
                  <form action={deactivateAction}>
                    <input type="hidden" name="persona_id" value={m.persona_id} />
                    <button type="submit" style={{ padding: '2px 8px', color: '#a31818' }}>Deactivate</button>
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
