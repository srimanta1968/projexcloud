import { redirect } from 'next/navigation';

async function createTenantAction(formData: FormData): Promise<void> {
  'use server';
  const body = {
    app_id: String(formData.get('app_id') ?? '').trim(),
    display_name: String(formData.get('display_name') ?? '').trim(),
    region: String(formData.get('region') ?? '').trim(),
    isolation_tier: String(formData.get('isolation_tier') ?? 'S') as 'S' | 'P' | 'G',
    brand_domain: String(formData.get('brand_domain') ?? '').trim() || undefined,
  };

  const res = await fetch(
    `${process.env.NEXT_PUBLIC_GATEWAY_URL}/admin/tenants`,
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-admin-ops-token': process.env.ADMIN_OPS_TOKEN ?? '',
      },
      body: JSON.stringify(body),
    },
  );

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Provision failed (${res.status}): ${err}`);
  }
  redirect('/tenants');
}

const FIELD: React.CSSProperties = {
  display: 'flex', flexDirection: 'column', gap: 4, marginBottom: 14,
};
const INPUT: React.CSSProperties = {
  padding: '8px 10px', border: '1px solid #d7dce4', borderRadius: 6, fontSize: 14,
};

export default function NewTenantPage(): JSX.Element {
  return (
    <div style={{ maxWidth: 560 }}>
      <h1>Provision new tenant</h1>
      <p style={{ color: '#5a6573' }}>
        Creates a row in <code>tenant.tenant</code>, emits <code>tenant.created.v1</code> +
        <code>tenant.pool.assigned.v1</code> through the audit chain, and assigns default pool
        placement. Reseller, BUs, fiscal calendar, and members come after.
      </p>

      <form action={createTenantAction}>
        <label style={FIELD}>
          <span><strong>App ID</strong> <em style={{ color: '#9aa3b2' }}>(required)</em></span>
          <input name="app_id" required placeholder="e.g. 11111111-1111-1111-1111-111111111111" style={INPUT} />
          <small style={{ color: '#7a8597' }}>
            UUID of the parent App (<code>tenant.app</code>). Create the App first if none exists.
          </small>
        </label>

        <label style={FIELD}>
          <span><strong>Display name</strong> <em style={{ color: '#9aa3b2' }}>(required)</em></span>
          <input name="display_name" required placeholder="Acme Corp" style={INPUT} />
        </label>

        <label style={FIELD}>
          <span><strong>Region</strong> <em style={{ color: '#9aa3b2' }}>(required)</em></span>
          <input name="region" required placeholder="us-east-1" style={INPUT} defaultValue="us-east-1" />
          <small style={{ color: '#7a8597' }}>
            Cloud region where the admin pool runs. Must align with any sovereign residency policy.
          </small>
        </label>

        <label style={FIELD}>
          <span><strong>Isolation tier</strong></span>
          <select name="isolation_tier" defaultValue="S" style={INPUT}>
            <option value="S">S — shared pool (default, multi-tenant)</option>
            <option value="P">P — premium (dedicated app pool)</option>
            <option value="G">G — gov / sovereign (fully isolated)</option>
          </select>
        </label>

        <label style={FIELD}>
          <span><strong>Brand domain</strong> <em style={{ color: '#9aa3b2' }}>(optional)</em></span>
          <input name="brand_domain" placeholder="acme.projexcloud.com" style={INPUT} />
        </label>

        <div style={{ display: 'flex', gap: 12, marginTop: 16 }}>
          <button
            type="submit"
            style={{
              background: '#0b1220', color: '#fff', padding: '10px 18px',
              borderRadius: 6, border: 'none', fontSize: 14, cursor: 'pointer',
            }}
          >
            Provision tenant
          </button>
          <a
            href="/tenants"
            style={{
              padding: '10px 18px', borderRadius: 6, border: '1px solid #d7dce4',
              textDecoration: 'none', color: '#0b1220', fontSize: 14,
            }}
          >
            Cancel
          </a>
        </div>
      </form>
    </div>
  );
}
