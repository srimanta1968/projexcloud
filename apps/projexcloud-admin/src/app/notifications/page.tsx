import { revalidatePath } from 'next/cache';
import { Button, Field, Input, PageHeader, Select } from '@projexlight/design-system';
import { requirePlatformOperator } from '../../lib/session';

/**
 * Platform-default email provider (projexcloud-admin, platform-operator only).
 * The notification agent falls back to this provider when a tenant has not
 * configured their own. Credentials are envelope-encrypted by the gateway and
 * never returned. Gated by requirePlatformOperator (fail-closed).
 */

interface PlatformProvider {
  provider_id: string;
  kind: string;
  config: Record<string, unknown>;
  from_address: string | null;
  last_4: string | null;
  status: string;
  created_at?: string;
}

async function fetchProvider(): Promise<PlatformProvider | null> {
  try {
    const res = await fetch(`${process.env.NEXT_PUBLIC_GATEWAY_URL}/admin/notifications/providers`, {
      cache: 'no-store',
      headers: { 'x-admin-ops-token': process.env.ADMIN_OPS_TOKEN ?? '' },
    });
    if (!res.ok) return null;
    return (await res.json()).data ?? null;
  } catch {
    return null;
  }
}

async function setProviderAction(formData: FormData): Promise<void> {
  'use server';
  await requirePlatformOperator();
  const kind = String(formData.get('kind') ?? '').trim();
  const from_address = String(formData.get('from_address') ?? '').trim();
  const credential = String(formData.get('credential') ?? '');
  const config: Record<string, unknown> = {};
  if (kind === 'smtp') {
    config.host = String(formData.get('host') ?? '').trim();
    config.port = Number(formData.get('port') ?? 587);
    config.secure = formData.get('secure') === 'on';
    const user = String(formData.get('user') ?? '').trim();
    if (user) config.user = user;
  }
  const body = { kind, from_address: from_address || undefined, credential: credential || undefined, config };
  const res = await fetch(`${process.env.NEXT_PUBLIC_GATEWAY_URL}/admin/notifications/providers`, {
    method: 'POST',
    cache: 'no-store',
    headers: { 'content-type': 'application/json', 'x-admin-ops-token': process.env.ADMIN_OPS_TOKEN ?? '' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Set provider failed (${res.status}): ${await res.text()}`);
  revalidatePath('/notifications');
}

export default async function PlatformEmailProviderPage(): Promise<JSX.Element> {
  await requirePlatformOperator();
  const provider = await fetchProvider();

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Platform-default email provider"
        description={
          <>
            The email provider the notification agent uses when a tenant has not configured their
            own (SMTP / SendGrid / SES). Secrets are envelope-encrypted server-side and never shown.
            Platform-operator only.
          </>
        }
      />

      <div className="rounded-lg border p-4">
        <h2 className="mb-2 text-sm font-semibold">Current</h2>
        {provider ? (
          <p className="text-sm">
            <strong>{provider.kind}</strong> · from <code>{provider.from_address ?? '—'}</code> · key{' '}
            <code>…{provider.last_4 ?? '—'}</code> · <span className="text-green-700">{provider.status}</span>
          </p>
        ) : (
          <p className="text-sm text-muted-foreground">No platform-default provider configured.</p>
        )}
      </div>

      <div className="rounded-lg border p-4">
        <h2 className="mb-3 text-sm font-semibold">Set / replace</h2>
        <form action={setProviderAction} className="flex max-w-xl flex-col gap-3">
          <Field label="Kind" htmlFor="kind">
            <Select id="kind" name="kind" defaultValue="smtp">
              <option value="smtp">SMTP</option>
              <option value="sendgrid">SendGrid</option>
              <option value="ses">AWS SES</option>
            </Select>
          </Field>
          <Field label="From address" htmlFor="from_address">
            <Input id="from_address" name="from_address" type="email" placeholder="welcome@projexlight.com" />
          </Field>
          <Field label="SMTP host (smtp only)" htmlFor="host">
            <Input id="host" name="host" placeholder="smtp.zoho.com" />
          </Field>
          <div className="flex gap-3">
            <Field label="Port (smtp)" htmlFor="port">
              <Input id="port" name="port" type="number" placeholder="465" defaultValue="465" />
            </Field>
            <label className="mt-6 flex items-center gap-2 text-sm">
              <input type="checkbox" name="secure" defaultChecked className="h-4 w-4" /> TLS (secure)
            </label>
          </div>
          <Field label="SMTP user (smtp)" htmlFor="user">
            <Input id="user" name="user" placeholder="welcome@projexlight.com" autoComplete="off" />
          </Field>
          <Field
            label="Credential (SMTP password / API key — write-only)"
            htmlFor="credential"
          >
            <Input id="credential" name="credential" type="password" autoComplete="off" required minLength={4} />
          </Field>
          <div>
            <Button type="submit">Save platform provider</Button>
          </div>
        </form>
      </div>
    </div>
  );
}
