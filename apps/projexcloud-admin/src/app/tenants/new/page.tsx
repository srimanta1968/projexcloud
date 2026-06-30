import Link from 'next/link';
import { redirect } from 'next/navigation';
import { Button, Field, Input, PageHeader, Select } from '@projexlight/design-system';
import { requireSession } from '../../../lib/session';

async function createTenantAction(formData: FormData): Promise<void> {
  'use server';
  // Verify an authenticated operator session BEFORE the ADMIN_OPS_TOKEN is used,
  // so an unauthenticated server-action invocation provisions nothing.
  await requireSession();
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

const REQUIRED = <em className="text-muted-foreground">(required)</em>;

export default function NewTenantPage(): JSX.Element {
  return (
    <div className="max-w-xl">
      <PageHeader
        title="Provision new tenant"
        description={
          <>
            Creates a row in <code>tenant.tenant</code>, emits <code>tenant.created.v1</code> +
            <code>tenant.pool.assigned.v1</code> through the audit chain, and assigns default pool
            placement. Reseller, BUs, fiscal calendar, and members come after.
          </>
        }
      />

      <form action={createTenantAction} className="flex flex-col gap-3.5">
        <Field
          label={<>App ID {REQUIRED}</>}
          htmlFor="app_id"
          hint={<>UUID of the parent App (<code>tenant.app</code>). Create the App first if none exists.</>}
        >
          <Input id="app_id" name="app_id" required placeholder="e.g. 11111111-1111-1111-1111-111111111111" />
        </Field>

        <Field label={<>Display name {REQUIRED}</>} htmlFor="display_name">
          <Input id="display_name" name="display_name" required placeholder="Acme Corp" />
        </Field>

        <Field
          label={<>Region {REQUIRED}</>}
          htmlFor="region"
          hint="Cloud region where the admin pool runs. Must align with any sovereign residency policy."
        >
          <Input id="region" name="region" required placeholder="us-east-1" defaultValue="us-east-1" />
        </Field>

        <Field label="Isolation tier" htmlFor="isolation_tier">
          <Select id="isolation_tier" name="isolation_tier" defaultValue="S">
            <option value="S">S — shared pool (default, multi-tenant)</option>
            <option value="P">P — premium (dedicated app pool)</option>
            <option value="G">G — gov / sovereign (fully isolated)</option>
          </Select>
        </Field>

        <Field label={<>Brand domain <em className="text-muted-foreground">(optional)</em></>} htmlFor="brand_domain">
          <Input id="brand_domain" name="brand_domain" placeholder="acme.projexcloud.com" />
        </Field>

        <div className="mt-2 flex gap-3">
          <Button type="submit">Provision tenant</Button>
          <Button asChild variant="secondary"><Link href="/tenants">Cancel</Link></Button>
        </div>
      </form>
    </div>
  );
}
