import Link from 'next/link';

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
  if (!d) return <div><Link href="/invoices">← Back</Link><h1>Invoice not found</h1></div>;
  const inv = d.invoice;
  return (
    <div>
      <Link href="/invoices">← Back to invoices</Link>
      <h1 style={{ fontFamily: 'monospace' }}>{inv.invoice_id}</h1>
      <div style={{ color: '#5a6573' }}>Status: <strong>{inv.status}</strong> · Total: {(inv.total_cents / 100).toFixed(2)} {inv.currency}</div>

      <h2 style={{ marginTop: 24 }}>Line items</h2>
      <table style={{ width: '100%', borderCollapse: 'collapse' }}>
        <thead style={{ textAlign: 'left', borderBottom: '1px solid #d7dce4' }}>
          <tr>
            <th style={{ padding: 6 }}>SKU</th>
            <th style={{ padding: 6, textAlign: 'right' }}>Units</th>
            <th style={{ padding: 6, textAlign: 'right' }}>Rate</th>
            <th style={{ padding: 6, textAlign: 'right' }}>Subtotal</th>
          </tr>
        </thead>
        <tbody>
          {d.line_items.length === 0 && <tr><td colSpan={4} style={{ padding: 12, color: '#9aa3b2' }}>No line items.</td></tr>}
          {d.line_items.map((li) => (
            <tr key={li.line_id} style={{ borderBottom: '1px solid #eef0f4' }}>
              <td style={{ padding: 6, fontFamily: 'monospace' }}>{li.sku}</td>
              <td style={{ padding: 6, textAlign: 'right' }}>{li.units}</td>
              <td style={{ padding: 6, textAlign: 'right' }}>{li.rate}</td>
              <td style={{ padding: 6, textAlign: 'right' }}>{(li.subtotal_cents / 100).toFixed(2)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
