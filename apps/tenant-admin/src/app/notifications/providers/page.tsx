import { cookies } from 'next/headers';
import { revalidatePath } from 'next/cache';
import { SESSION_COOKIE } from '@projexlight/design-system/auth';
import {
  Button,
  Card,
  Field,
  Input,
  Select,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@projexlight/design-system';

/**
 * Tenant email provider configuration (tenant-admin). Lets a tenant bring their
 * own email server (SMTP) or provider (SendGrid / SES) so their app's
 * notification agent sends from their own domain/infrastructure.
 *
 * These endpoints are JWT-authed (tenant_id derives from the caller's token),
 * so we forward the portal session cookie as a Bearer token. Secrets are
 * write-only: the API returns only last_4 + non-secret config.
 */

const GATEWAY = process.env.NEXT_PUBLIC_GATEWAY_URL;

interface ProviderRow {
  binding_id: string;
  kind: string;
  config: Record<string, unknown>;
  from_address: string | null;
  last_4: string;
  status: 'active' | 'revoked';
  bound_at: string;
}

/** Bearer header from the portal session cookie (the six-layer JWT). */
function authHeaders(json = false): Record<string, string> {
  const token = cookies().get(SESSION_COOKIE)?.value ?? '';
  const h: Record<string, string> = { Authorization: `Bearer ${token}` };
  if (json) h['content-type'] = 'application/json';
  return h;
}

async function fetchProviders(): Promise<ProviderRow[]> {
  try {
    const res = await fetch(`${GATEWAY}/api/notifications/providers`, {
      cache: 'no-store',
      headers: authHeaders(),
    });
    if (!res.ok) return [];
    return (await res.json())?.data?.providers ?? [];
  } catch {
    return [];
  }
}

async function bindAction(formData: FormData): Promise<void> {
  'use server';
  const kind = String(formData.get('kind') ?? '').trim();
  const from_address = String(formData.get('from_address') ?? '').trim();
  const credential = String(formData.get('credential') ?? '');
  if (!kind || !credential) return;
  const config: Record<string, unknown> = {};
  if (kind === 'smtp') {
    config.host = String(formData.get('host') ?? '').trim();
    config.port = Number(formData.get('port') ?? 587);
    config.secure = formData.get('secure') === 'on';
    const user = String(formData.get('user') ?? '').trim();
    if (user) config.user = user;
  }
  await fetch(`${GATEWAY}/api/notifications/providers`, {
    method: 'POST',
    cache: 'no-store',
    headers: authHeaders(true),
    body: JSON.stringify({ kind, from_address: from_address || undefined, credential, config }),
  });
  revalidatePath('/notifications/providers');
}

async function rotateAction(formData: FormData): Promise<void> {
  'use server';
  const provider_id = String(formData.get('provider_id') ?? '');
  const credential = String(formData.get('credential') ?? '');
  if (!provider_id || !credential) return;
  await fetch(`${GATEWAY}/api/notifications/providers/${encodeURIComponent(provider_id)}`, {
    method: 'PATCH',
    cache: 'no-store',
    headers: authHeaders(true),
    body: JSON.stringify({ credential }),
  });
  revalidatePath('/notifications/providers');
}

async function verifyAction(formData: FormData): Promise<void> {
  'use server';
  const provider_id = String(formData.get('provider_id') ?? '');
  const to = String(formData.get('to') ?? '').trim();
  if (!provider_id || !to) return;
  await fetch(`${GATEWAY}/api/notifications/providers/${encodeURIComponent(provider_id)}/verify`, {
    method: 'POST',
    cache: 'no-store',
    headers: authHeaders(true),
    body: JSON.stringify({ to }),
  });
  revalidatePath('/notifications/providers');
}

async function revokeAction(formData: FormData): Promise<void> {
  'use server';
  const provider_id = String(formData.get('provider_id') ?? '');
  const reason = String(formData.get('reason') ?? '').trim();
  if (!provider_id || reason.length < 6) return;
  await fetch(`${GATEWAY}/api/notifications/providers/${encodeURIComponent(provider_id)}`, {
    method: 'DELETE',
    cache: 'no-store',
    headers: authHeaders(true),
    body: JSON.stringify({ reason }),
  });
  revalidatePath('/notifications/providers');
}

export default async function TenantEmailProvidersPage(): Promise<JSX.Element> {
  const providers = await fetchProviders();
  const active = providers.filter((p) => p.status === 'active');

  return (
    <div>
      <h1 className="text-2xl font-bold tracking-tight">Email provider (BYO)</h1>
      <p className="mb-4 mt-1 max-w-2xl text-sm text-muted-foreground">
        Configure your own email server so your app&apos;s notification agent sends from your domain.
        We store the credential envelope-encrypted and never show it again — only the last 4 characters.
        When set, your provider is used; otherwise the platform default is used.
      </p>

      <div className="rounded-lg border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Kind</TableHead>
              <TableHead>From</TableHead>
              <TableHead>Last 4</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Bound at</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {providers.length === 0 && (
              <TableRow>
                <TableCell colSpan={5} className="text-muted-foreground">
                  No provider configured — using the platform default.
                </TableCell>
              </TableRow>
            )}
            {providers.map((p) => (
              <TableRow key={p.binding_id}>
                <TableCell>{p.kind}</TableCell>
                <TableCell className="font-mono text-xs">{p.from_address ?? '—'}</TableCell>
                <TableCell className="font-mono">…{p.last_4}</TableCell>
                <TableCell className={p.status === 'active' ? 'text-green-700' : 'text-muted-foreground'}>
                  {p.status}
                </TableCell>
                <TableCell className="text-xs text-muted-foreground">
                  {new Date(p.bound_at).toLocaleString()}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>

      <Card className="mt-4 max-w-2xl p-5">
        <h2 className="text-base font-semibold">Configure your email provider</h2>
        <form action={bindAction} className="mt-3 flex flex-col gap-3.5">
          <Field label="Kind" htmlFor="kind">
            <Select id="kind" name="kind" defaultValue="smtp">
              <option value="smtp">SMTP (your own server)</option>
              <option value="sendgrid">SendGrid</option>
              <option value="ses">AWS SES</option>
            </Select>
          </Field>
          <Field label="From address" htmlFor="from_address">
            <Input id="from_address" name="from_address" type="email" placeholder="noreply@yourdomain.com" />
          </Field>
          <Field label="SMTP host (smtp only)" htmlFor="host">
            <Input id="host" name="host" placeholder="smtp.yourdomain.com" />
          </Field>
          <div className="flex gap-3">
            <Field label="Port" htmlFor="port">
              <Input id="port" name="port" type="number" placeholder="465" defaultValue="465" />
            </Field>
            <label className="mt-6 flex items-center gap-2 text-sm">
              <input type="checkbox" name="secure" defaultChecked className="h-4 w-4" /> TLS
            </label>
          </div>
          <Field label="SMTP user (smtp only)" htmlFor="user">
            <Input id="user" name="user" autoComplete="off" placeholder="noreply@yourdomain.com" />
          </Field>
          <Field label="Credential (SMTP password / API key — write-only)" htmlFor="credential">
            <Input id="credential" name="credential" type="password" required minLength={4} autoComplete="off" />
          </Field>
          <Button type="submit" className="self-start">Save provider</Button>
        </form>
      </Card>

      {active.map((p) => (
        <Card key={p.binding_id} className="mt-4 max-w-2xl bg-muted p-5">
          <h3 className="text-[15px] font-semibold">
            {p.kind} — <code>{p.binding_id}</code>
          </h3>

          <form action={verifyAction} className="mt-3 flex items-center gap-2">
            <input type="hidden" name="provider_id" value={p.binding_id} />
            <Input name="to" type="email" placeholder="send test email to…" required className="flex-1" />
            <Button type="submit" variant="secondary">Send test</Button>
          </form>

          <form action={rotateAction} className="mt-3 flex items-center gap-2">
            <input type="hidden" name="provider_id" value={p.binding_id} />
            <Input name="credential" type="password" placeholder="new credential" required minLength={4} autoComplete="off" className="flex-1" />
            <Button type="submit">Rotate</Button>
          </form>

          <form action={revokeAction} className="mt-3 rounded-md border border-destructive/40 bg-destructive/5 p-3">
            <input type="hidden" name="provider_id" value={p.binding_id} />
            <p className="mb-2 text-[13px] text-destructive">
              <strong>Danger zone.</strong> Revoking falls future email back to the platform default. Type a reason ≥ 6 chars.
            </p>
            <div className="flex gap-2">
              <Input name="reason" type="text" placeholder="reason (min 6 chars)" required minLength={6} className="flex-1" />
              <Button type="submit" variant="danger">Revoke</Button>
            </div>
          </form>
        </Card>
      ))}
    </div>
  );
}
