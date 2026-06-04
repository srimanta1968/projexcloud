import { revalidatePath } from 'next/cache';
import {
  Button,
  Card,
  Field,
  Input,
  PageHeader,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@projexlight/design-system';
import { StatusBadge } from '../../components/StatusBadge';

interface EndpointRow {
  endpoint_id: string;
  url: string;
  status: string;
  failure_streak: number;
  last_success_at: string | null;
}

interface DlqRow {
  delivery_id: string;
  event_type: string;
  attempts: number;
  failed_at: string;
}

const TENANT_ID = process.env.TENANT_ADMIN_TENANT_ID ?? '';

async function fetchEndpoints(): Promise<EndpointRow[]> {
  if (!TENANT_ID) return [];
  try {
    const res = await fetch(
      `${process.env.NEXT_PUBLIC_GATEWAY_URL}/api/webhooks/endpoints?tenant_id=${encodeURIComponent(TENANT_ID)}`,
      { cache: 'no-store' },
    );
    if (!res.ok) return [];
    return (await res.json()).data ?? [];
  } catch { return []; }
}

async function fetchDlq(): Promise<DlqRow[]> {
  try {
    const res = await fetch(`${process.env.NEXT_PUBLIC_GATEWAY_URL}/api/webhooks/dlq`, { cache: 'no-store' });
    if (!res.ok) return [];
    return (await res.json()).data ?? [];
  } catch { return []; }
}

async function registerAction(formData: FormData): Promise<void> {
  'use server';
  await fetch(`${process.env.NEXT_PUBLIC_GATEWAY_URL}/api/webhooks/endpoints`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      tenant_id: TENANT_ID,
      url: String(formData.get('url') ?? ''),
      signing_key_ref: String(formData.get('signing_key_ref') ?? ''),
    }),
  });
  revalidatePath('/webhooks');
}

export default async function WebhooksPage(): Promise<JSX.Element> {
  const [endpoints, dlq] = await Promise.all([fetchEndpoints(), fetchDlq()]);
  return (
    <div>
      <PageHeader title="Webhooks" description="Register outbound endpoints and inspect the dead-letter queue." />

      <Card className="mb-6 max-w-2xl p-5">
        <h2 className="mb-4 text-lg font-semibold">Register endpoint</h2>
        <form action={registerAction} className="grid gap-3.5">
          <Field label="URL (https://…)" htmlFor="url">
            <Input id="url" name="url" required type="url" />
          </Field>
          <Field label="Signing key ref" htmlFor="signing_key_ref">
            <Input id="signing_key_ref" name="signing_key_ref" required placeholder="vault:hmac/webhook-default" />
          </Field>
          <Button type="submit" className="justify-self-start">Register</Button>
        </form>
        <p className="mt-3 text-xs text-muted-foreground">
          On-prem strict-mode tenants: only in-cluster URLs accepted (FR-ONP-6).
        </p>
      </Card>

      <h2 className="mb-3 text-lg font-semibold">Endpoints</h2>
      <div className="mb-6 rounded-lg border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Endpoint</TableHead>
              <TableHead>URL</TableHead>
              <TableHead>Status</TableHead>
              <TableHead className="text-right">Failures</TableHead>
              <TableHead>Last success</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {endpoints.length === 0 && (
              <TableRow><TableCell colSpan={5} className="text-muted-foreground">No endpoints.</TableCell></TableRow>
            )}
            {endpoints.map((e) => (
              <TableRow key={e.endpoint_id}>
                <TableCell className="font-mono text-[11px]">{e.endpoint_id}</TableCell>
                <TableCell className="break-all text-xs">{e.url}</TableCell>
                <TableCell><StatusBadge status={e.status} /></TableCell>
                <TableCell className="text-right tabular-nums">{e.failure_streak}</TableCell>
                <TableCell className="text-xs text-muted-foreground">{e.last_success_at ? new Date(e.last_success_at).toLocaleString() : '—'}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>

      <h2 className="mb-3 text-lg font-semibold">DLQ</h2>
      <div className="rounded-lg border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Delivery</TableHead>
              <TableHead>Event type</TableHead>
              <TableHead className="text-right">Attempts</TableHead>
              <TableHead>Failed at</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {dlq.length === 0 && (
              <TableRow><TableCell colSpan={4} className="text-muted-foreground">DLQ empty.</TableCell></TableRow>
            )}
            {dlq.map((d) => (
              <TableRow key={d.delivery_id}>
                <TableCell className="font-mono text-[11px]">{d.delivery_id}</TableCell>
                <TableCell className="font-mono text-xs">{d.event_type}</TableCell>
                <TableCell className="text-right tabular-nums">{d.attempts}</TableCell>
                <TableCell className="text-xs text-muted-foreground">{new Date(d.failed_at).toLocaleString()}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
