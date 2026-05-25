import Link from 'next/link';

interface InvoiceRow {
  invoice_id: string;
  tenant_id: string;
  period_start: string;
  period_end: string;
  total_cents: number;
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
      <h1>Invoices</h1>
      <p style={{ color: '#5a6573' }}>Search per-tenant invoices; reprice / void from the detail view.</p>

      <form method="get" style={{ display: 'flex', gap: 8, marginTop: 16, alignItems: 'center' }}>
        <input name="tenant_id" defaultValue={searchParams.tenant_id} placeholder="tenant_id (UUID)" style={{ padding: 4, width: 320 }} />
        <input name="from" type="date" defaultValue={searchParams.from} style={{ padding: 4 }} />
        <input name="to" type="date" defaultValue={searchParams.to} style={{ padding: 4 }} />
        <button type="submit" style={{ padding: '4px 12px' }}>Search</button>
      </form>

      <table style={{ width: '100%', borderCollapse: 'collapse', marginTop: 16 }}>
        <thead style={{ textAlign: 'left', borderBottom: '1px solid #d7dce4' }}>
          <tr>
            <th style={{ padding: 8 }}>Invoice</th>
            <th style={{ padding: 8 }}>Tenant</th>
            <th style={{ padding: 8 }}>Period</th>
            <th style={{ padding: 8, textAlign: 'right' }}>Total</th>
            <th style={{ padding: 8 }}>Status</th>
          </tr>
        </thead>
        <tbody>
          {invoices.length === 0 && <tr><td colSpan={5} style={{ padding: 12, color: '#9aa3b2' }}>No invoices match.</td></tr>}
          {invoices.map((i) => (
            <tr key={i.invoice_id} style={{ borderBottom: '1px solid #eef0f4' }}>
              <td style={{ padding: 8, fontFamily: 'monospace' }}>
                <Link href={`/invoices/${encodeURIComponent(i.invoice_id)}`}>{i.invoice_id}</Link>
              </td>
              <td style={{ padding: 8, fontFamily: 'monospace', fontSize: 12 }}>{i.tenant_id}</td>
              <td style={{ padding: 8 }}>{i.period_start} → {i.period_end}</td>
              <td style={{ padding: 8, textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>
                {(i.total_cents / 100).toFixed(2)} {i.currency}
              </td>
              <td style={{ padding: 8 }}>{i.status}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
