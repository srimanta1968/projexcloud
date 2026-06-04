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

interface CatalogRow {
  catalog_id: string;
  version: number;
  status: 'draft' | 'active' | 'retired';
  effective_from: string;
  effective_to: string | null;
  created_by: string;
  rate_count: number;
}

async function fetchCatalogs(): Promise<CatalogRow[]> {
  try {
    const res = await fetch(
      `${process.env.NEXT_PUBLIC_GATEWAY_URL}/admin/meter/pricing-catalogs`,
      {
        cache: 'no-store',
        headers: { 'x-admin-ops-token': process.env.ADMIN_OPS_TOKEN ?? '' },
      },
    );
    if (!res.ok) return [];
    const body = await res.json();
    return body.data ?? [];
  } catch {
    return [];
  }
}

export default async function PricingCatalogsPage(): Promise<JSX.Element> {
  const catalogs = await fetchCatalogs();
  return (
    <div>
      <PageHeader
        title="Pricing catalogs"
        description={
          <>
            Versioned rate cards consumed by the meter gate. Each catalog is immutable once
            retired; create a new version to roll prices forward. Sample defaults were seeded
            by migration <code>005_p7_skus.sql</code>; override here per the doctrine.
          </>
        }
      />
      <div className="rounded-lg border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Catalog</TableHead>
              <TableHead>Version</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Effective From</TableHead>
              <TableHead>Rates</TableHead>
              <TableHead>Created by</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {catalogs.length === 0 && (
              <TableRow>
                <TableCell colSpan={6} className="text-muted-foreground">
                  No catalogs visible. Make sure the gateway is up and ADMIN_OPS_TOKEN is set
                  in this app&apos;s env.
                </TableCell>
              </TableRow>
            )}
            {catalogs.map((c) => (
              <TableRow key={c.catalog_id}>
                <TableCell className="font-mono text-xs">
                  <Link href={`/pricing-catalogs/${encodeURIComponent(c.catalog_id)}`} className="text-primary hover:underline">
                    {c.catalog_id}
                  </Link>
                </TableCell>
                <TableCell>{c.version}</TableCell>
                <TableCell><StatusBadge status={c.status} /></TableCell>
                <TableCell>{new Date(c.effective_from).toLocaleString()}</TableCell>
                <TableCell>{c.rate_count}</TableCell>
                <TableCell className="text-muted-foreground">{c.created_by}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
