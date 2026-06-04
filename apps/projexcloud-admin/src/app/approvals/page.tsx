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

interface RouteRow {
  route_id: string;
  tenant_id: string;
  name: string;
  sla_minutes: number;
  created_at: string;
}

async function fetchRoutes(): Promise<RouteRow[]> {
  try {
    const res = await fetch(`${process.env.NEXT_PUBLIC_GATEWAY_URL}/admin/approvals/routes`, {
      cache: 'no-store',
      headers: { 'x-admin-ops-token': process.env.ADMIN_OPS_TOKEN ?? '' },
    });
    if (!res.ok) return [];
    return (await res.json()).data ?? [];
  } catch { return []; }
}

export default async function ApprovalsPage(): Promise<JSX.Element> {
  const routes = await fetchRoutes();
  return (
    <div>
      <PageHeader
        title="Approval routes"
        description={<>Cross-tenant view. See <Link href="/approvals/breaches" className="text-primary underline">SLA breaches</Link> for stuck requests.</>}
      />
      <div className="rounded-lg border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Route</TableHead>
              <TableHead>Tenant</TableHead>
              <TableHead>Name</TableHead>
              <TableHead className="text-right">SLA (min)</TableHead>
              <TableHead>Created</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {routes.length === 0 && (
              <TableRow><TableCell colSpan={5} className="text-muted-foreground">No routes registered.</TableCell></TableRow>
            )}
            {routes.map((r) => (
              <TableRow key={r.route_id}>
                <TableCell className="font-mono text-xs">{r.route_id}</TableCell>
                <TableCell className="font-mono text-xs">{r.tenant_id}</TableCell>
                <TableCell>{r.name}</TableCell>
                <TableCell className="text-right tabular-nums">{r.sla_minutes}</TableCell>
                <TableCell className="text-xs text-muted-foreground">{new Date(r.created_at).toLocaleString()}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
