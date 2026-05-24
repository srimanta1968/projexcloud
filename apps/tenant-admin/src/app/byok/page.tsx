import { revalidatePath } from 'next/cache';

interface BindingRow {
  binding_id: string;
  tenant_id: string;
  provider: 'aws-kms' | 'gcp-kms' | 'hsm-pkcs11';
  customer_kms_key_arn: string;
  tenant_key_id: string;
  grant_status: 'active' | 'revoking' | 'revoked' | 'degraded';
  bound_at: string;
  revoked_at: string | null;
  sla_revoke_propagation_seconds: number;
  siem_forwarder_endpoint: string | null;
}

const TENANT_ID = process.env.TENANT_ADMIN_TENANT_ID ?? '';

async function fetchBinding(): Promise<BindingRow | null> {
  if (!TENANT_ID) return null;
  try {
    const res = await fetch(
      `${process.env.NEXT_PUBLIC_GATEWAY_URL}/admin/byok/bindings/tenant/${encodeURIComponent(TENANT_ID)}`,
      {
        cache: 'no-store',
        headers: { 'x-admin-ops-token': process.env.ADMIN_OPS_TOKEN ?? '' },
      },
    );
    if (!res.ok) return null;
    const body = await res.json();
    return body.data ?? null;
  } catch {
    return null;
  }
}

async function bindCmkAction(formData: FormData): Promise<void> {
  'use server';
  const provider = String(formData.get('provider') ?? '');
  const customer_kms_key_arn = String(formData.get('customer_kms_key_arn') ?? '');
  const tenant_key_id = String(formData.get('tenant_key_id') ?? '');
  const siem_forwarder_endpoint = String(formData.get('siem_forwarder_endpoint') ?? '').trim() || null;
  await fetch(`${process.env.NEXT_PUBLIC_GATEWAY_URL}/admin/byok/bindings`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-admin-ops-token': process.env.ADMIN_OPS_TOKEN ?? '',
    },
    body: JSON.stringify({
      tenant_id: TENANT_ID,
      provider,
      customer_kms_key_arn,
      tenant_key_id,
      siem_forwarder_endpoint,
      operator_id: 'tenant-admin-ui',
    }),
  });
  revalidatePath('/byok');
}

async function revokeAction(formData: FormData): Promise<void> {
  'use server';
  const binding_id = String(formData.get('binding_id') ?? '');
  const reason = String(formData.get('reason') ?? '').trim();
  if (!reason) return;
  await fetch(
    `${process.env.NEXT_PUBLIC_GATEWAY_URL}/admin/byok/bindings/${encodeURIComponent(binding_id)}/revoke`,
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-admin-ops-token': process.env.ADMIN_OPS_TOKEN ?? '',
      },
      body: JSON.stringify({ reason, operator_id: 'tenant-admin-ui' }),
    },
  );
  revalidatePath('/byok');
}

function statusColor(status: string): string {
  switch (status) {
    case 'active': return '#0d8a3d';
    case 'revoking': return '#a36500';
    case 'revoked': return '#a31818';
    case 'degraded': return '#a31818';
    default: return '#000';
  }
}

export default async function ByokPage(): Promise<JSX.Element> {
  const binding = await fetchBinding();
  return (
    <div>
      <h1>BYOK / CMEK</h1>
      <p style={{ color: '#5a6573', maxWidth: 760 }}>
        Bring-your-own-key (P8 Variant A). Your CMK wraps the Tenant Key.
        Revoking the grant on your CMK renders this tenant&apos;s data undecryptable
        within {binding?.sla_revoke_propagation_seconds ?? 30}s — this is intentional and
        cannot be undone without re-binding.
      </p>

      {!TENANT_ID && (
        <div style={{ background: '#fff4d6', border: '1px solid #e3c47b', padding: 12, borderRadius: 4 }}>
          Set <code>TENANT_ADMIN_TENANT_ID</code> in this app&apos;s env to view your binding.
        </div>
      )}

      {binding && (
        <section style={{ marginTop: 24, padding: 16, border: '1px solid #d7dce4', borderRadius: 8 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <h2 style={{ margin: 0 }}>Active binding</h2>
            <span style={{ color: statusColor(binding.grant_status), fontWeight: 600 }}>
              {binding.grant_status}
            </span>
          </div>
          <dl style={{ display: 'grid', gridTemplateColumns: '160px 1fr', gap: '6px 12px', marginTop: 12, fontSize: 14 }}>
            <dt style={{ color: '#5a6573' }}>Binding ID</dt><dd style={{ margin: 0, fontFamily: 'monospace' }}>{binding.binding_id}</dd>
            <dt style={{ color: '#5a6573' }}>Provider</dt><dd style={{ margin: 0 }}>{binding.provider}</dd>
            <dt style={{ color: '#5a6573' }}>Customer key ARN</dt><dd style={{ margin: 0, fontFamily: 'monospace', wordBreak: 'break-all' }}>{binding.customer_kms_key_arn}</dd>
            <dt style={{ color: '#5a6573' }}>Tenant key ID</dt><dd style={{ margin: 0, fontFamily: 'monospace' }}>{binding.tenant_key_id}</dd>
            <dt style={{ color: '#5a6573' }}>Bound at</dt><dd style={{ margin: 0 }}>{new Date(binding.bound_at).toLocaleString()}</dd>
            <dt style={{ color: '#5a6573' }}>Revoke SLA</dt><dd style={{ margin: 0 }}>{binding.sla_revoke_propagation_seconds}s</dd>
            <dt style={{ color: '#5a6573' }}>SIEM endpoint</dt><dd style={{ margin: 0 }}>{binding.siem_forwarder_endpoint ?? <em>not configured</em>}</dd>
          </dl>

          {binding.grant_status === 'active' && (
            <form action={revokeAction} style={{ marginTop: 16, padding: 12, background: '#fff5f5', border: '1px solid #e3a8a8', borderRadius: 4 }}>
              <input type="hidden" name="binding_id" value={binding.binding_id} />
              <p style={{ marginTop: 0, color: '#a31818' }}>
                <strong>Danger zone.</strong> Revoking will render all tenant data undecryptable. Confirm by typing a reason:
              </p>
              <input name="reason" placeholder="reason (required)" style={{ width: '60%', padding: 6 }} required minLength={6} />
              <button type="submit" style={{ marginLeft: 8, padding: '6px 16px', background: '#a31818', color: 'white', border: 'none', borderRadius: 4 }}>
                Revoke CMK binding
              </button>
            </form>
          )}
        </section>
      )}

      {!binding && TENANT_ID && (
        <section style={{ marginTop: 24, padding: 16, border: '1px solid #d7dce4', borderRadius: 8 }}>
          <h2 style={{ marginTop: 0 }}>Bind a customer-managed key</h2>
          <form action={bindCmkAction} style={{ display: 'grid', gap: 12, maxWidth: 640 }}>
            <label>
              Provider
              <select name="provider" required style={{ display: 'block', width: '100%', padding: 6, marginTop: 4 }}>
                <option value="aws-kms">AWS KMS</option>
                <option value="gcp-kms">GCP KMS</option>
                <option value="hsm-pkcs11">HSM (PKCS#11)</option>
              </select>
            </label>
            <label>
              Customer KMS key ARN / handle
              <input name="customer_kms_key_arn" required style={{ display: 'block', width: '100%', padding: 6, marginTop: 4 }} />
            </label>
            <label>
              Tenant Key ID (existing platform key to wrap)
              <input name="tenant_key_id" required style={{ display: 'block', width: '100%', padding: 6, marginTop: 4 }} />
            </label>
            <label>
              SIEM forwarder endpoint (optional)
              <input name="siem_forwarder_endpoint" placeholder="https://siem.example.com/ingest" style={{ display: 'block', width: '100%', padding: 6, marginTop: 4 }} />
            </label>
            <button type="submit" style={{ padding: '8px 16px', background: '#1b2a44', color: 'white', border: 'none', borderRadius: 4 }}>
              Bind CMK
            </button>
          </form>
        </section>
      )}
    </div>
  );
}
