import { revalidatePath } from 'next/cache';
import { Button, Card, Field, Input, PageHeader, Select } from '@projexlight/design-system';

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
      <PageHeader
        title="On-prem installs"
        description={
          <>
            P8 Variant C. Single-cluster Kubernetes distributions for banks / government / classified workloads.
            Quarterly signed-bundle releases; local AI Gateway (Llama / Mistral via Ollama or vLLM); webhook outbound
            restricted to in-cluster endpoints when <code>air_gap_mode=strict</code>; no phone-home telemetry.
          </>
        }
      />

      <Card className="max-w-2xl p-5">
        <h2 className="mb-4 text-lg font-semibold">Register a new install</h2>
        <form action={registerInstallAction} className="grid gap-3.5">
          <Field label="Customer ID" htmlFor="customer_id">
            <Input id="customer_id" name="customer_id" required />
          </Field>
          <Field label="Cluster name" htmlFor="cluster_name">
            <Input id="cluster_name" name="cluster_name" required />
          </Field>
          <Field label="K8s distribution" htmlFor="k8s_distribution">
            <Select id="k8s_distribution" name="k8s_distribution" required>
              <option value="vanilla">vanilla</option>
              <option value="openshift">openshift</option>
              <option value="rancher">rancher</option>
              <option value="tanzu">tanzu</option>
            </Select>
          </Field>
          <Field label="Installed version (semver)" htmlFor="installed_version">
            <Input id="installed_version" name="installed_version" required placeholder="1.0.0" />
          </Field>
          <Field label="Air-gap mode" htmlFor="air_gap_mode">
            <Select id="air_gap_mode" name="air_gap_mode" required>
              <option value="strict">strict (no external, no phone-home)</option>
              <option value="diode-in">diode-in (one-way inbound)</option>
              <option value="diode-bidi">diode-bidi (one-way both)</option>
            </Select>
          </Field>
          <Field label="Billing mode" htmlFor="billing_mode">
            <Select id="billing_mode" name="billing_mode" required>
              <option value="internal-report-only">internal-report-only</option>
              <option value="flat-fee">flat-fee</option>
              <option value="per-incident">per-incident</option>
            </Select>
          </Field>
          <Button type="submit" className="justify-self-start">Register install</Button>
        </form>
        <p className="mt-4 text-[13px] text-muted-foreground">
          After registration, set the gateway env <code>ONPREM_INSTALL_ID</code> to the returned id so the cross-SDK
          hooks (local LLM resolver, webhook validator) activate.
        </p>
      </Card>
    </div>
  );
}
