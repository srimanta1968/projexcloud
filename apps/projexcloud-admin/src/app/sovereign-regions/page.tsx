import { revalidatePath } from 'next/cache';

interface RegionRow {
  region_id: string;
  regime: 'fedramp-high' | 'il5' | 'pipl' | 'eu-sovereign' | 'uae-trd';
  operator_partner: string;
  terminal_federation: boolean;
  kms_provider: string;
  activated_at: string;
  attestation_state: 'in-progress' | 'attested' | 'expired';
}

async function fetchRegions(): Promise<RegionRow[]> {
  try {
    const res = await fetch(
      `${process.env.NEXT_PUBLIC_GATEWAY_URL}/admin/sovereign/regions`,
      {
        cache: 'no-store',
        headers: { 'x-admin-ops-token': process.env.ADMIN_OPS_TOKEN ?? '' },
      },
    );
    if (!res.ok) return [];
    const body = await res.json();
    return body.data ?? [];
  } catch {
    return [];
  }
}

async function registerRegionAction(formData: FormData): Promise<void> {
  'use server';
  await fetch(`${process.env.NEXT_PUBLIC_GATEWAY_URL}/admin/sovereign/regions`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-admin-ops-token': process.env.ADMIN_OPS_TOKEN ?? '',
    },
    body: JSON.stringify({
      region_id: String(formData.get('region_id') ?? ''),
      regime: String(formData.get('regime') ?? ''),
      operator_partner: String(formData.get('operator_partner') ?? ''),
      terminal_federation: formData.get('terminal_federation') === 'on',
      kms_provider: String(formData.get('kms_provider') ?? ''),
      operator_id: 'admin-ui',
    }),
  });
  revalidatePath('/sovereign-regions');
}

function attestationColor(s: string): string {
  return s === 'attested' ? '#0d8a3d' : s === 'in-progress' ? '#a36500' : '#a31818';
}

export default async function SovereignRegionsPage(): Promise<JSX.Element> {
  const regions = await fetchRegions();
  return (
    <div>
      <h1>Sovereign regions</h1>
      <p style={{ color: '#5a6573' }}>
        P8 Variant B. Isolated regions (FedRAMP-High / IL5 / PIPL / EU sovereign / UAE TRD).
        Pool Router federation manifest treats <code>terminal_federation=true</code> regions as terminal —
        cross-region routes targeting them are refused with HTTP 451.
      </p>

      <table style={{ width: '100%', borderCollapse: 'collapse', marginTop: 16 }}>
        <thead style={{ textAlign: 'left', borderBottom: '1px solid #d7dce4' }}>
          <tr>
            <th style={{ padding: 8 }}>Region</th>
            <th style={{ padding: 8 }}>Regime</th>
            <th style={{ padding: 8 }}>Operator</th>
            <th style={{ padding: 8 }}>Terminal</th>
            <th style={{ padding: 8 }}>KMS</th>
            <th style={{ padding: 8 }}>Attestation</th>
            <th style={{ padding: 8 }}>Activated</th>
          </tr>
        </thead>
        <tbody>
          {regions.length === 0 && (
            <tr><td colSpan={7} style={{ padding: 12, color: '#9aa3b2' }}>No regions registered. Add one below.</td></tr>
          )}
          {regions.map((r) => (
            <tr key={r.region_id} style={{ borderBottom: '1px solid #eef0f4' }}>
              <td style={{ padding: 8, fontFamily: 'monospace' }}>{r.region_id}</td>
              <td style={{ padding: 8 }}>{r.regime}</td>
              <td style={{ padding: 8 }}>{r.operator_partner}</td>
              <td style={{ padding: 8 }}>{r.terminal_federation ? 'yes' : 'no'}</td>
              <td style={{ padding: 8 }}>{r.kms_provider}</td>
              <td style={{ padding: 8, color: attestationColor(r.attestation_state), fontWeight: 600 }}>{r.attestation_state}</td>
              <td style={{ padding: 8, color: '#5a6573' }}>{new Date(r.activated_at).toLocaleString()}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <section style={{ marginTop: 32, padding: 16, border: '1px solid #d7dce4', borderRadius: 8, maxWidth: 720 }}>
        <h2 style={{ marginTop: 0 }}>Register a sovereign region</h2>
        <form action={registerRegionAction} style={{ display: 'grid', gap: 12 }}>
          <label>Region ID <input name="region_id" required style={{ display: 'block', width: '100%', padding: 6 }} placeholder="us-gov-east-1" /></label>
          <label>
            Regime
            <select name="regime" required style={{ display: 'block', width: '100%', padding: 6 }}>
              <option value="fedramp-high">FedRAMP-High</option>
              <option value="il5">IL5</option>
              <option value="pipl">PIPL (China)</option>
              <option value="eu-sovereign">EU sovereign</option>
              <option value="uae-trd">UAE TRD</option>
            </select>
          </label>
          <label>Operator partner <input name="operator_partner" required style={{ display: 'block', width: '100%', padding: 6 }} /></label>
          <label>KMS provider <input name="kms_provider" required style={{ display: 'block', width: '100%', padding: 6 }} /></label>
          <label><input type="checkbox" name="terminal_federation" defaultChecked /> Terminal federation (refuse cross-region routes)</label>
          <button type="submit" style={{ padding: '8px 16px', background: '#0b1220', color: 'white', border: 'none', borderRadius: 4 }}>Register region</button>
        </form>
      </section>
    </div>
  );
}
