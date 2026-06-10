import { revalidatePath } from 'next/cache';
import { Button, Card, Field, Input, PageHeader } from '@projexlight/design-system';

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
      <PageHeader
        title="Active-Active Tier-G+"
        description="P8 Variant D. Synchronous replication for audit/payment, async for everything else. Per-tenant home region with paired replicas. RPO ≤ 5s · RTO ≤ 60s. Monthly chaos drills run automatically; two consecutive failed drills trigger an automatic tier downgrade."
      />

      <Card className="max-w-2xl p-5">
        <h2 className="mb-4 text-lg font-semibold">Activate Tier-G+ profile</h2>
        <form action={activateProfileAction} className="grid gap-3.5">
          <Field label="Tenant ID (UUID)" htmlFor="tenant_id">
            <Input id="tenant_id" name="tenant_id" required />
          </Field>
          <Field label="Home region" htmlFor="home_region">
            <Input id="home_region" name="home_region" required placeholder="us-east" />
          </Field>
          <Field label="Paired regions (comma-separated)" htmlFor="paired_regions">
            <Input id="paired_regions" name="paired_regions" required placeholder="us-west, eu-west" />
          </Field>
          <Field label="Contract addendum ref" htmlFor="contract_addendum_ref">
            <Input id="contract_addendum_ref" name="contract_addendum_ref" required placeholder="CT-AA-2026-001" />
          </Field>
          <Field label="RPO target (s)" htmlFor="rpo_target_seconds">
            <Input id="rpo_target_seconds" type="number" name="rpo_target_seconds" defaultValue={5} min={1} />
          </Field>
          <Field label="RTO target (s)" htmlFor="rto_target_seconds">
            <Input id="rto_target_seconds" type="number" name="rto_target_seconds" defaultValue={60} min={1} />
          </Field>
          <Button type="submit" className="justify-self-start">Activate profile</Button>
        </form>
      </Card>

      <Card className="mt-8 max-w-2xl p-5">
        <h2 className="mb-1 text-lg font-semibold">Run failover drill</h2>
        <p className="mb-4 text-[13px] text-muted-foreground">
          Operator-triggered chaos drill. The monthly scheduler runs drills automatically; this form is
          for ad-hoc tests (e.g. before a release).
        </p>
        <form action={runDrillAction} className="grid gap-3.5">
          <Field label="Profile ID" htmlFor="profile_id">
            <Input id="profile_id" name="profile_id" required className="font-mono" />
          </Field>
          <Field label="To region" htmlFor="to_region">
            <Input id="to_region" name="to_region" required placeholder="us-west" />
          </Field>
          <Button type="submit" className="justify-self-start bg-warning text-warning-foreground hover:bg-warning/90">Run drill</Button>
        </form>
      </Card>
    </div>
  );
}
