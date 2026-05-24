import { revalidatePath } from 'next/cache';

async function registerInstallAction(formData: FormData): Promise<void> {
  'use server';
  await fetch(`${process.env.NEXT_PUBLIC_GATEWAY_URL}/admin/onprem/installs`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-admin-ops-token': process.env.ADMIN_OPS_TOKEN ?? '',
    },
    body: JSON.stringify({
      customer_id: String(formData.get('customer_id') ?? ''),
      cluster_name: String(formData.get('cluster_name') ?? ''),
      k8s_distribution: String(formData.get('k8s_distribution') ?? ''),
      installed_version: String(formData.get('installed_version') ?? ''),
      air_gap_mode: String(formData.get('air_gap_mode') ?? 'strict'),
      billing_mode: String(formData.get('billing_mode') ?? 'internal-report-only'),
    }),
  });
  revalidatePath('/onprem-installs');
}

export default function OnPremInstallsPage(): JSX.Element {
  return (
    <div>
      <h1>On-prem installs</h1>
      <p style={{ color: '#5a6573', maxWidth: 760 }}>
        P8 Variant C. Single-cluster Kubernetes distributions for banks / government / classified workloads.
        Quarterly signed-bundle releases; local AI Gateway (Llama / Mistral via Ollama or vLLM); webhook outbound
        restricted to in-cluster endpoints when <code>air_gap_mode=strict</code>; no phone-home telemetry.
      </p>

      <section style={{ marginTop: 24, padding: 16, border: '1px solid #d7dce4', borderRadius: 8, maxWidth: 720 }}>
        <h2 style={{ marginTop: 0 }}>Register a new install</h2>
        <form action={registerInstallAction} style={{ display: 'grid', gap: 12 }}>
          <label>Customer ID <input name="customer_id" required style={{ display: 'block', width: '100%', padding: 6 }} /></label>
          <label>Cluster name <input name="cluster_name" required style={{ display: 'block', width: '100%', padding: 6 }} /></label>
          <label>
            K8s distribution
            <select name="k8s_distribution" required style={{ display: 'block', width: '100%', padding: 6 }}>
              <option value="vanilla">vanilla</option>
              <option value="openshift">openshift</option>
              <option value="rancher">rancher</option>
              <option value="tanzu">tanzu</option>
            </select>
          </label>
          <label>Installed version (semver) <input name="installed_version" required style={{ display: 'block', width: '100%', padding: 6 }} placeholder="1.0.0" /></label>
          <label>
            Air-gap mode
            <select name="air_gap_mode" required style={{ display: 'block', width: '100%', padding: 6 }}>
              <option value="strict">strict (no external, no phone-home)</option>
              <option value="diode-in">diode-in (one-way inbound)</option>
              <option value="diode-bidi">diode-bidi (one-way both)</option>
            </select>
          </label>
          <label>
            Billing mode
            <select name="billing_mode" required style={{ display: 'block', width: '100%', padding: 6 }}>
              <option value="internal-report-only">internal-report-only</option>
              <option value="flat-fee">flat-fee</option>
              <option value="per-incident">per-incident</option>
            </select>
          </label>
          <button type="submit" style={{ padding: '8px 16px', background: '#0b1220', color: 'white', border: 'none', borderRadius: 4 }}>Register install</button>
        </form>
        <p style={{ marginTop: 16, color: '#5a6573', fontSize: 13 }}>
          After registration, set the gateway env <code>ONPREM_INSTALL_ID</code> to the returned id so the cross-SDK
          hooks (local LLM resolver, webhook validator) activate.
        </p>
      </section>
    </div>
  );
}
