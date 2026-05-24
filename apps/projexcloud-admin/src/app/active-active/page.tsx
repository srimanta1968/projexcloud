import { revalidatePath } from 'next/cache';

async function activateProfileAction(formData: FormData): Promise<void> {
  'use server';
  const paired = String(formData.get('paired_regions') ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  await fetch(`${process.env.NEXT_PUBLIC_GATEWAY_URL}/admin/active-active/profiles`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-admin-ops-token': process.env.ADMIN_OPS_TOKEN ?? '',
    },
    body: JSON.stringify({
      tenant_id: String(formData.get('tenant_id') ?? ''),
      home_region: String(formData.get('home_region') ?? ''),
      paired_regions: paired,
      contract_addendum_ref: String(formData.get('contract_addendum_ref') ?? ''),
      rpo_target_seconds: parseInt(String(formData.get('rpo_target_seconds') ?? '5'), 10),
      rto_target_seconds: parseInt(String(formData.get('rto_target_seconds') ?? '60'), 10),
    }),
  });
  revalidatePath('/active-active');
}

async function runDrillAction(formData: FormData): Promise<void> {
  'use server';
  const profile_id = String(formData.get('profile_id') ?? '');
  const to_region = String(formData.get('to_region') ?? '');
  await fetch(
    `${process.env.NEXT_PUBLIC_GATEWAY_URL}/admin/active-active/profiles/${encodeURIComponent(profile_id)}/drills`,
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-admin-ops-token': process.env.ADMIN_OPS_TOKEN ?? '',
      },
      body: JSON.stringify({ to_region }),
    },
  );
  revalidatePath('/active-active');
}

export default function ActiveActivePage(): JSX.Element {
  return (
    <div>
      <h1>Active-Active Tier-G+</h1>
      <p style={{ color: '#5a6573', maxWidth: 760 }}>
        P8 Variant D. Synchronous replication for audit/payment, async for everything else.
        Per-tenant home region with paired replicas. RPO ≤ 5s · RTO ≤ 60s.
        Monthly chaos drills run automatically; two consecutive failed drills trigger an automatic tier downgrade.
      </p>

      <section style={{ marginTop: 24, padding: 16, border: '1px solid #d7dce4', borderRadius: 8, maxWidth: 720 }}>
        <h2 style={{ marginTop: 0 }}>Activate Tier-G+ profile</h2>
        <form action={activateProfileAction} style={{ display: 'grid', gap: 12 }}>
          <label>Tenant ID (UUID) <input name="tenant_id" required style={{ display: 'block', width: '100%', padding: 6 }} /></label>
          <label>Home region <input name="home_region" required style={{ display: 'block', width: '100%', padding: 6 }} placeholder="us-east" /></label>
          <label>Paired regions (comma-separated) <input name="paired_regions" required style={{ display: 'block', width: '100%', padding: 6 }} placeholder="us-west, eu-west" /></label>
          <label>Contract addendum ref <input name="contract_addendum_ref" required style={{ display: 'block', width: '100%', padding: 6 }} placeholder="CT-AA-2026-001" /></label>
          <label>RPO target (s) <input type="number" name="rpo_target_seconds" defaultValue={5} min={1} style={{ display: 'block', width: '100%', padding: 6 }} /></label>
          <label>RTO target (s) <input type="number" name="rto_target_seconds" defaultValue={60} min={1} style={{ display: 'block', width: '100%', padding: 6 }} /></label>
          <button type="submit" style={{ padding: '8px 16px', background: '#0b1220', color: 'white', border: 'none', borderRadius: 4 }}>Activate profile</button>
        </form>
      </section>

      <section style={{ marginTop: 32, padding: 16, border: '1px solid #d7dce4', borderRadius: 8, maxWidth: 720 }}>
        <h2 style={{ marginTop: 0 }}>Run failover drill</h2>
        <p style={{ color: '#5a6573', fontSize: 13 }}>
          Operator-triggered chaos drill. The monthly scheduler runs drills automatically; this form is
          for ad-hoc tests (e.g. before a release).
        </p>
        <form action={runDrillAction} style={{ display: 'grid', gap: 12 }}>
          <label>Profile ID <input name="profile_id" required style={{ display: 'block', width: '100%', padding: 6, fontFamily: 'monospace' }} /></label>
          <label>To region <input name="to_region" required style={{ display: 'block', width: '100%', padding: 6 }} placeholder="us-west" /></label>
          <button type="submit" style={{ padding: '8px 16px', background: '#a36500', color: 'white', border: 'none', borderRadius: 4 }}>Run drill</button>
        </form>
      </section>
    </div>
  );
}
