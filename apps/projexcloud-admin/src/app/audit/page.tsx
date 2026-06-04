import { revalidatePath } from 'next/cache';
import {
  Button,
  Input,
  PageHeader,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@projexlight/design-system';

interface EntryRow {
  entry_id: string;
  tenant_id: string;
  actor_kind: string;
  actor_id: string;
  action: string;
  occurred_at: string;
  seq: number;
}

async function fetchEntries(q: { tenant_id?: string; actor_id?: string; from?: string; to?: string }): Promise<EntryRow[]> {
  const qs = new URLSearchParams();
  if (q.tenant_id) qs.set('tenant_id', q.tenant_id);
  if (q.actor_id) qs.set('actor_id', q.actor_id);
  if (q.from) qs.set('from', q.from);
  if (q.to) qs.set('to', q.to);
  try {
    const res = await fetch(
      `${process.env.NEXT_PUBLIC_GATEWAY_URL}/admin/audit/entries?${qs.toString()}`,
      { cache: 'no-store', headers: { 'x-admin-ops-token': process.env.ADMIN_OPS_TOKEN ?? '' } },
    );
    if (!res.ok) return [];
    return (await res.json()).data ?? [];
  } catch { return []; }
}

async function verifyAction(formData: FormData): Promise<void> {
  'use server';
  const tenant_id = String(formData.get('tenant_id') ?? '');
  if (!tenant_id) return;
  await fetch(
    `${process.env.NEXT_PUBLIC_GATEWAY_URL}/admin/audit/verify?tenant_id=${encodeURIComponent(tenant_id)}`,
    {
      method: 'POST',
      headers: { 'x-admin-ops-token': process.env.ADMIN_OPS_TOKEN ?? '' },
    },
  );
  revalidatePath('/audit');
}

export default async function AuditPage({
  searchParams,
}: {
  searchParams: { tenant_id?: string; actor_id?: string; from?: string; to?: string };
}): Promise<JSX.Element> {
  const entries = await fetchEntries(searchParams);
  return (
    <div>
      <PageHeader
        title="Audit hash-chain browser"
        description="Filter and verify the per-tenant audit chain. Gap or hash-mismatch returns the failing seq."
      />

      <form method="get" className="mb-3 flex flex-wrap items-center gap-2">
        <Input name="tenant_id" defaultValue={searchParams.tenant_id} placeholder="tenant_id (UUID)" className="w-80" />
        <Input name="actor_id" defaultValue={searchParams.actor_id} placeholder="actor_id" className="w-52" />
        <Input name="from" type="datetime-local" defaultValue={searchParams.from} className="w-auto" />
        <Input name="to" type="datetime-local" defaultValue={searchParams.to} className="w-auto" />
        <Button type="submit">Filter</Button>
      </form>

      {searchParams.tenant_id && (
        <form action={verifyAction} className="mb-4">
          <input type="hidden" name="tenant_id" value={searchParams.tenant_id} />
          <Button type="submit">Verify chain for this tenant</Button>
        </form>
      )}

      <div className="rounded-lg border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Entry</TableHead>
              <TableHead className="text-right">Seq</TableHead>
              <TableHead>When</TableHead>
              <TableHead>Actor</TableHead>
              <TableHead>Action</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {entries.length === 0 && (
              <TableRow><TableCell colSpan={5} className="text-muted-foreground">No entries match.</TableCell></TableRow>
            )}
            {entries.map((e) => (
              <TableRow key={e.entry_id}>
                <TableCell className="font-mono text-[11px]">{e.entry_id}</TableCell>
                <TableCell className="text-right tabular-nums">{e.seq}</TableCell>
                <TableCell className="text-muted-foreground">{new Date(e.occurred_at).toLocaleString()}</TableCell>
                <TableCell className="text-xs">{e.actor_kind}:{e.actor_id}</TableCell>
                <TableCell className="font-mono text-xs">{e.action}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
