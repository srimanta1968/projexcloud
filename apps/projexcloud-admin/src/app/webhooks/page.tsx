import Link from 'next/link';
import {
  Badge,
  PageHeader,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  cn,
} from '@projexlight/design-system';

interface EndpointRow {
  endpoint_id: string;
  tenant_id: string;
  url: string;
  status: string;
  failure_streak: number;
  last_success_at: string | null;
  last_failure_at: string | null;
}

async function fetchEndpoints(): Promise<EndpointRow[]> {
  try {
    const res = await fetch(`${process.env.NEXT_PUBLIC_GATEWAY_URL}/admin/webhooks`, {
      cache: 'no-store',
      headers: { 'x-admin-ops-token': process.env.ADMIN_OPS_TOKEN ?? '' },
    });
    if (!res.ok) return [];
    return (await res.json()).data ?? [];
  } catch { return []; }
}

export default async function WebhooksPage(): Promise<JSX.Element> {
  const endpoints = await fetchEndpoints();
  return (
    <div>
      <PageHeader
        title="Webhooks"
        description={<>Cross-tenant endpoint view. Use the <Link href="/webhooks/dlq" className="text-primary underline">DLQ</Link> page to replay failed deliveries.</>}
      />
      <div className="rounded-lg border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Endpoint</TableHead>
              <TableHead>Tenant</TableHead>
              <TableHead>URL</TableHead>
              <TableHead>Status</TableHead>
              <TableHead className="text-right">Fail streak</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {endpoints.length === 0 && (
              <TableRow><TableCell colSpan={5} className="text-muted-foreground">No endpoints.</TableCell></TableRow>
            )}
            {endpoints.map((e) => (
              <TableRow key={e.endpoint_id}>
                <TableCell className="font-mono text-xs">{e.endpoint_id}</TableCell>
                <TableCell className="font-mono text-xs">{e.tenant_id}</TableCell>
                <TableCell className="break-all text-xs">{e.url}</TableCell>
                <TableCell>
                  <Badge
                    variant="outline"
                    className={cn('uppercase tracking-wide', e.status === 'active' ? 'bg-green-50 text-green-700 border-green-200' : 'bg-red-50 text-red-700 border-red-200')}
                  >
                    {e.status}
                  </Badge>
                </TableCell>
                <TableCell className="text-right tabular-nums">{e.failure_streak}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
