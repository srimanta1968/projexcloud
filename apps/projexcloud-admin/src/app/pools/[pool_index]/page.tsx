import { revalidatePath } from 'next/cache';
import Link from 'next/link';
import {
  Button,
  Card,
  Input,
  Select,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@projexlight/design-system';

interface PoolDetail {
  pool: {
    pool_index: string;
    region: string;
    isolation_class: string;
    status: string;
    replication_role: string | null;
    replicates_from_pool_index: string | null;
    created_at: string;
    updated_at: string;
  };
  tenant_count: number;
  lifecycle_history: Array<{
    to_status: string;
    reason: string | null;
    occurred_at: string;
    operator_id: string;
  }>;
}

async function fetchDetail(poolIndex: string): Promise<PoolDetail | null> {
  try {
    const res = await fetch(
      `${process.env.NEXT_PUBLIC_GATEWAY_URL}/admin/pools/${encodeURIComponent(poolIndex)}`,
      {
        cache: 'no-store',
        headers: { 'x-admin-ops-token': process.env.ADMIN_OPS_TOKEN ?? '' },
      },
    );
    if (!res.ok) return null;
    return (await res.json()).data ?? null;
  } catch { return null; }
}

async function flipStatus(formData: FormData): Promise<void> {
  'use server';
  const pool_index = String(formData.get('pool_index') ?? '');
  await fetch(
    `${process.env.NEXT_PUBLIC_GATEWAY_URL}/admin/pools/${encodeURIComponent(pool_index)}/status`,
    {
      method: 'PATCH',
      headers: {
        'content-type': 'application/json',
        'x-admin-ops-token': process.env.ADMIN_OPS_TOKEN ?? '',
      },
      body: JSON.stringify({
        to_status: String(formData.get('to_status') ?? ''),
        reason: String(formData.get('reason') ?? ''),
        operator_id: 'admin-ui',
      }),
    },
  );
  revalidatePath(`/pools/${pool_index}`);
}

export default async function PoolDetailPage({ params }: { params: { pool_index: string } }): Promise<JSX.Element> {
  const d = await fetchDetail(params.pool_index);
  if (!d) {
    return (
      <div>
        <Link href="/pools" className="text-sm text-primary hover:underline">← Back</Link>
        <h1 className="mt-3 text-2xl font-bold tracking-tight">Pool not found</h1>
      </div>
    );
  }
  const detailRows: Array<[string, React.ReactNode]> = [
    ['Region', d.pool.region],
    ['Capacity', d.pool.isolation_class],
    ['Status', <span className="font-semibold">{d.pool.status}</span>],
    ['Replication role', d.pool.replication_role ?? '—'],
    ['Replicates from', <span className="font-mono">{d.pool.replicates_from_pool_index ?? '—'}</span>],
    ['Tenants', d.tenant_count],
    ['Created', new Date(d.pool.created_at).toLocaleString()],
  ];
  return (
    <div>
      <Link href="/pools" className="text-sm text-primary hover:underline">← Back to pools</Link>
      <h1 className="mb-4 mt-2 font-mono text-2xl font-bold">{d.pool.pool_index}</h1>

      <Card className="max-w-xl p-5">
        <dl className="grid grid-cols-[180px_1fr] gap-x-3 gap-y-1.5 text-sm">
          {detailRows.map(([label, value]) => (
            <div key={label} className="contents">
              <dt className="text-muted-foreground">{label}</dt>
              <dd className="m-0">{value}</dd>
            </div>
          ))}
        </dl>
      </Card>

      <h2 className="mb-3 mt-6 text-lg font-semibold">Flip status</h2>
      <form action={flipStatus} className="flex max-w-2xl items-center gap-2">
        <input type="hidden" name="pool_index" value={d.pool.pool_index} />
        <Select name="to_status" defaultValue={d.pool.status} className="w-44">
          <option value="active">active</option>
          <option value="draining">draining</option>
          <option value="quiesced">quiesced</option>
          <option value="retired">retired</option>
        </Select>
        <Input name="reason" placeholder="reason (required)" required minLength={4} className="flex-1" />
        <Button type="submit">Apply</Button>
      </form>

      <h2 className="mb-3 mt-6 text-lg font-semibold">Lifecycle history</h2>
      <div className="rounded-lg border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>When</TableHead>
              <TableHead>To status</TableHead>
              <TableHead>Reason</TableHead>
              <TableHead>Operator</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {d.lifecycle_history.length === 0 && (
              <TableRow><TableCell colSpan={4} className="text-muted-foreground">No history yet.</TableCell></TableRow>
            )}
            {d.lifecycle_history.map((e, i) => (
              <TableRow key={i}>
                <TableCell>{new Date(e.occurred_at).toLocaleString()}</TableCell>
                <TableCell>{e.to_status}</TableCell>
                <TableCell className="text-muted-foreground">{e.reason ?? '—'}</TableCell>
                <TableCell>{e.operator_id}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
