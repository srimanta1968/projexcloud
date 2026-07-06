import Link from 'next/link';
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

interface InvoiceRow {
  invoice_id: string;
  tenant_id: string;
  period_start: string;
  period_end: string;
  total: string | number;
  currency: string;
  status: string;
  finalized_at: string | null;
  created_at: string;
}

async function fetchInvoices(q: { tenant_id?: string; from?: string; to?: string }): Promise<InvoiceRow[]> {
  const qs = new URLSearchParams();
  if (q.tenant_id) qs.set('tenant_id', q.tenant_id);
  if (q.from) qs.set('from', q.from);
  if (q.to) qs.set('to', q.to);
  try {
    const res = await fetch(
      `${process.env.NEXT_PUBLIC_GATEWAY_URL}/admin/invoices?${qs.toString()}`,
      {
        cache: 'no-store',
        headers: { 'x-admin-ops-token': process.env.ADMIN_OPS_TOKEN ?? '' },
      },
    );
    if (!res.ok) return [];
    return (await res.json()).data ?? [];
  } catch { return []; }
}

export default async function InvoicesPage({
  searchParams,
}: {
  searchParams: { tenant_id?: string; from?: string; to?: string };
}): Promise<JSX.Element> {
  const invoices = await fetchInvoices(searchParams);
  return (
    <div>
      <PageHeader
        title="Invoices"
        description="Search per-tenant invoices; reprice / void from the detail view."
      />

      <form method="get" className="mb-4 flex flex-wrap items-center gap-2">
        <Input name="tenant_id" defaultValue={searchParams.tenant_id} placeholder="tenant_id (UUID)" className="w-80" />
        <Input name="from" type="date" defaultValue={searchParams.from} className="w-auto" />
        <Input name="to" type="date" defaultValue={searchParams.to} className="w-auto" />
        <Button type="submit">Search</Button>
      </form>

      <div className="rounded-lg border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Invoice</TableHead>
              <TableHead>Tenant</TableHead>
              <TableHead>Period</TableHead>
              <TableHead className="text-right">Total</TableHead>
              <TableHead>Status</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {invoices.length === 0 && (
              <TableRow><TableCell colSpan={5} className="text-muted-foreground">No invoices match.</TableCell></TableRow>
            )}
            {invoices.map((i) => (
              <TableRow key={i.invoice_id}>
                <TableCell className="font-mono">
                  <Link href={`/invoices/${encodeURIComponent(i.invoice_id)}`} className="text-primary hover:underline">{i.invoice_id}</Link>
                </TableCell>
                <TableCell className="font-mono text-xs">{i.tenant_id}</TableCell>
                <TableCell>{i.period_start} → {i.period_end}</TableCell>
                <TableCell className="text-right tabular-nums">{Number(i.total).toFixed(2)} {i.currency}</TableCell>
                <TableCell>{i.status}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
