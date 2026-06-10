import Link from 'next/link';
import {
  Button,
  PageHeader,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@projexlight/design-system';

interface TenantRow {
  tenant_id: string;
  display_name: string;
  app_id: string;
  region: string;
  isolation_tier: string;
  status: string;
  created_at: string;
}

async function fetchTenants(): Promise<TenantRow[]> {
  try {
    const res = await fetch(
      `${process.env.NEXT_PUBLIC_GATEWAY_URL}/admin/tenants`,
      {
        cache: 'no-store',
        headers: { 'x-admin-ops-token': process.env.ADMIN_OPS_TOKEN ?? '' },
      },
    );
    if (!res.ok) return [];
    const body = await res.json();
    return body.data?.tenants ?? [];
  } catch {
    return [];
  }
}

export default async function TenantsPage(): Promise<JSX.Element> {
  const tenants = await fetchTenants();
  return (
    <div>
      <PageHeader
        title="Tenants"
        description="Lifecycle state per tenant. Each row links to per-tenant actions (suspend, reinstate, offboard) under the Tenant Lifecycle SDK."
        actions={
          <Button asChild size="sm">
            <Link href="/tenants/new">+ New tenant</Link>
          </Button>
        }
      />
      <div className="rounded-lg border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Tenant ID</TableHead>
              <TableHead>Display name</TableHead>
              <TableHead>App</TableHead>
              <TableHead>Region</TableHead>
              <TableHead>Tier</TableHead>
              <TableHead>Status</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {tenants.length === 0 && (
              <TableRow>
                <TableCell colSpan={6} className="text-muted-foreground">
                  No tenants yet. Click <strong>+ New tenant</strong> to provision the first one.
                  If you expected rows, check that the gateway is reachable at <code>{process.env.NEXT_PUBLIC_GATEWAY_URL}</code> and that <code>ADMIN_OPS_TOKEN</code> matches between the gateway and this app.
                </TableCell>
              </TableRow>
            )}
            {tenants.map((t) => (
              <TableRow key={t.tenant_id}>
                <TableCell className="font-mono text-xs">{t.tenant_id}</TableCell>
                <TableCell>{t.display_name}</TableCell>
                <TableCell className="font-mono text-xs">{t.app_id}</TableCell>
                <TableCell>{t.region}</TableCell>
                <TableCell>{t.isolation_tier}</TableCell>
                <TableCell>{t.status}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
