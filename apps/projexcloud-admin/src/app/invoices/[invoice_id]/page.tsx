import Link from 'next/link';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@projexlight/design-system';

interface InvoiceDetail {
  invoice: Record<string, unknown> & { invoice_id: string; status: string; total_cents: number; currency: string };
  line_items: Array<{ line_id: string; sku: string; units: number; rate: number; subtotal_cents: number }>;
}

async function fetchDetail(id: string): Promise<InvoiceDetail | null> {
  try {
    const res = await fetch(
      `${process.env.NEXT_PUBLIC_GATEWAY_URL}/admin/invoices/${encodeURIComponent(id)}`,
      { cache: 'no-store', headers: { 'x-admin-ops-token': process.env.ADMIN_OPS_TOKEN ?? '' } },
    );
    if (!res.ok) return null;
    return (await res.json()).data ?? null;
  } catch { return null; }
}

export default async function InvoiceDetailPage({ params }: { params: { invoice_id: string } }): Promise<JSX.Element> {
  const d = await fetchDetail(params.invoice_id);
  if (!d) {
    return (
      <div>
        <Link href="/invoices" className="text-sm text-primary hover:underline">← Back</Link>
        <h1 className="mt-3 text-2xl font-bold tracking-tight">Invoice not found</h1>
      </div>
    );
  }
  const inv = d.invoice;
  return (
    <div>
      <Link href="/invoices" className="text-sm text-primary hover:underline">← Back to invoices</Link>
      <h1 className="mb-1 mt-2 font-mono text-2xl font-bold">{inv.invoice_id}</h1>
      <div className="mb-4 text-sm text-muted-foreground">
        Status: <strong>{inv.status}</strong> · Total: {(inv.total_cents / 100).toFixed(2)} {inv.currency}
      </div>

      <h2 className="mb-3 mt-6 text-lg font-semibold">Line items</h2>
      <div className="rounded-lg border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>SKU</TableHead>
              <TableHead className="text-right">Units</TableHead>
              <TableHead className="text-right">Rate</TableHead>
              <TableHead className="text-right">Subtotal</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {d.line_items.length === 0 && (
              <TableRow><TableCell colSpan={4} className="text-muted-foreground">No line items.</TableCell></TableRow>
            )}
            {d.line_items.map((li) => (
              <TableRow key={li.line_id}>
                <TableCell className="font-mono text-xs">{li.sku}</TableCell>
                <TableCell className="text-right tabular-nums">{li.units}</TableCell>
                <TableCell className="text-right tabular-nums">{li.rate}</TableCell>
                <TableCell className="text-right tabular-nums">{(li.subtotal_cents / 100).toFixed(2)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
