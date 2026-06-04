import { revalidatePath } from 'next/cache';
import { cookies } from 'next/headers';
import {
  Alert,
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

interface KeyRow {
  key_id: string;
  name: string;
  scope: string;
  status: string;
  issued_at: string;
  last_used_at: string | null;
  expires_at: string | null;
}

const TENANT_ID = process.env.TENANT_ADMIN_TENANT_ID ?? '';

async function fetchKeys(): Promise<KeyRow[]> {
  if (!TENANT_ID) return [];
  try {
    const res = await fetch(
      `${process.env.NEXT_PUBLIC_GATEWAY_URL}/api/keys?tenant_id=${encodeURIComponent(TENANT_ID)}`,
      { cache: 'no-store' },
    );
    if (!res.ok) return [];
    return (await res.json()).data ?? [];
  } catch { return []; }
}

async function issueKey(formData: FormData): Promise<void> {
  'use server';
  const name = String(formData.get('name') ?? '');
  const scope = String(formData.get('scope') ?? '');
  const res = await fetch(`${process.env.NEXT_PUBLIC_GATEWAY_URL}/api/keys`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ tenant_id: TENANT_ID, name, scope }),
  });
  if (res.ok) {
    const body = await res.json();
    // Stash plaintext in an httpOnly cookie so the next render can show + clear it.
    cookies().set('issued_key_plaintext', body.data?.plaintext ?? '', { httpOnly: false, maxAge: 60 });
    cookies().set('issued_key_id', body.data?.key_id ?? '', { httpOnly: false, maxAge: 60 });
  }
  revalidatePath('/api-keys');
}

async function revokeKey(formData: FormData): Promise<void> {
  'use server';
  const key_id = String(formData.get('key_id') ?? '');
  await fetch(`${process.env.NEXT_PUBLIC_GATEWAY_URL}/api/keys/${encodeURIComponent(key_id)}/revoke`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ reason: String(formData.get('reason') ?? 'tenant-admin revoke') }),
  });
  revalidatePath('/api-keys');
}

export default async function ApiKeysPage(): Promise<JSX.Element> {
  const keys = await fetchKeys();
  const issuedPlaintext = cookies().get('issued_key_plaintext')?.value;
  const issuedId = cookies().get('issued_key_id')?.value;
  if (issuedPlaintext) {
    // One-shot reveal; clear after rendering.
    cookies().delete('issued_key_plaintext');
    cookies().delete('issued_key_id');
  }
  return (
    <div>
      <PageHeader title="API keys" description="Issue, view, and revoke API keys for this tenant." />

      {issuedPlaintext && (
        <Alert variant="success" className="mb-4">
          <strong>Save this key now — it won&apos;t be shown again.</strong>
          <div className="mt-1.5 break-all font-mono">{issuedPlaintext}</div>
          <div className="mt-1 text-xs text-muted-foreground">key_id: {issuedId}</div>
        </Alert>
      )}

      <Card className="mb-6 max-w-xl p-5">
        <h2 className="mb-4 text-lg font-semibold">Issue new key</h2>
        <form action={issueKey} className="grid gap-3.5">
          <Field label="Name" htmlFor="name">
            <Input id="name" name="name" required />
          </Field>
          <Field label="Scope" htmlFor="scope">
            <Input id="scope" name="scope" required placeholder="read:*, write:engagement" />
          </Field>
          <Button type="submit" className="justify-self-start">Issue</Button>
        </form>
      </Card>

      <div className="rounded-lg border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Key</TableHead>
              <TableHead>Name</TableHead>
              <TableHead>Scope</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Issued</TableHead>
              <TableHead>Last used</TableHead>
              <TableHead></TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {keys.length === 0 && (
              <TableRow><TableCell colSpan={7} className="text-muted-foreground">No keys.</TableCell></TableRow>
            )}
            {keys.map((k) => (
              <TableRow key={k.key_id}>
                <TableCell className="font-mono text-[11px]">{k.key_id}</TableCell>
                <TableCell>{k.name}</TableCell>
                <TableCell className="text-xs">{k.scope}</TableCell>
                <TableCell><StatusBadge status={k.status} /></TableCell>
                <TableCell className="text-xs text-muted-foreground">{new Date(k.issued_at).toLocaleString()}</TableCell>
                <TableCell className="text-xs text-muted-foreground">{k.last_used_at ? new Date(k.last_used_at).toLocaleString() : '—'}</TableCell>
                <TableCell>
                  {k.status === 'active' && (
                    <form action={revokeKey} className="flex items-center gap-2">
                      <input type="hidden" name="key_id" value={k.key_id} />
                      <Input name="reason" placeholder="reason" required minLength={4} className="h-8 w-36" />
                      <Button type="submit" size="sm" variant="ghost" className="text-destructive hover:text-destructive">Revoke</Button>
                    </form>
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
