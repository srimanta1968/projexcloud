import Link from 'next/link';
import {
  PageHeader,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@projexlight/design-system';
import { StatusBadge } from '../../components/StatusBadge';

interface PoolRow {
  pool_index: string;
  region: string;
  isolation_class: string;
  status: string;
  replication_role: string | null;
  replicates_from_pool_index: string | null;
}

async function fetchPools(): Promise<PoolRow[]> {
  try {
    const res = await fetch(`${process.env.NEXT_PUBLIC_GATEWAY_URL}/admin/pools`, {
      cache: 'no-store',
      headers: { 'x-admin-ops-token': process.env.ADMIN_OPS_TOKEN ?? '' },
    });
    if (!res.ok) return [];
    return (await res.json()).data ?? [];
  } catch { return []; }
}

export default async function PoolsPage(): Promise<JSX.Element> {
  const pools = await fetchPools();
  return (
    <div>
      <PageHeader
        title="Pools"
        description="Routing pool registry. Status flips emit pool.lifecycle.changed.v1."
      />
      <div className="rounded-lg border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Pool</TableHead>
              <TableHead>Region</TableHead>
              <TableHead>Capacity</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Replication</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {pools.length === 0 && (
              <TableRow>
                <TableCell colSpan={5} className="text-muted-foreground">No pools registered.</TableCell>
              </TableRow>
            )}
            {pools.map((p) => (
              <TableRow key={p.pool_index}>
                <TableCell className="font-mono">
                  <Link href={`/pools/${encodeURIComponent(p.pool_index)}`} className="text-primary hover:underline">{p.pool_index}</Link>
                </TableCell>
                <TableCell>{p.region}</TableCell>
                <TableCell>{p.isolation_class}</TableCell>
                <TableCell><StatusBadge status={p.status} /></TableCell>
                <TableCell className="text-muted-foreground">
                  {p.replication_role ?? '—'}
                  {p.replicates_from_pool_index ? ` ← ${p.replicates_from_pool_index}` : ''}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
