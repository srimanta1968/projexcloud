interface LiveMeter {
  subtotal: number;
  current_period_start: string;
  lag_ms: number;
  by_sku: Record<string, { units: number; amount: number }>;
}

async function fetchLiveMeter(tenant_id: string): Promise<LiveMeter | null> {
  try {
    const res = await fetch(
      `${process.env.NEXT_PUBLIC_GATEWAY_URL}/api/billing/live?tenant_id=${tenant_id}`,
      { cache: 'no-store' },
    );
    if (!res.ok) return null;
    const body = await res.json();
    return body.data;
  } catch {
    return null;
  }
}

export default async function BillingPage(): Promise<JSX.Element> {
  // Replace with the calling persona's tenant from the JWT once auth is wired
  // through the Next.js middleware — for now we read from query string or env.
  const tenant_id = process.env.NEXT_PUBLIC_DEMO_TENANT_ID ?? '00000000-0000-0000-0000-000000000001';
  const meter = await fetchLiveMeter(tenant_id);

  return (
    <div>
      <h1>Billing</h1>
      <p style={{ color: '#5a6573' }}>
        Live meter — current period accrual updated within ≈60s of meter ingest (FR-BIL-7).
      </p>

      {!meter && (
        <div style={{ padding: 12, background: '#fff3cd', borderRadius: 6, marginTop: 16 }}>
          Gateway unreachable or tenant has no current-period usage.
        </div>
      )}

      {meter && (
        <>
          <div style={{ marginTop: 16, display: 'flex', gap: 24 }}>
            <div>
              <div style={{ fontSize: 12, color: '#5a6573' }}>Subtotal (since {meter.current_period_start})</div>
              <div style={{ fontSize: 32, fontWeight: 700 }}>${meter.subtotal.toFixed(2)}</div>
            </div>
            <div>
              <div style={{ fontSize: 12, color: '#5a6573' }}>Meter lag</div>
              <div style={{ fontSize: 32, fontWeight: 700 }}>{meter.lag_ms}ms</div>
            </div>
          </div>

          <h2 style={{ marginTop: 32 }}>By SKU</h2>
          <table style={{ width: '100%', borderCollapse: 'collapse', marginTop: 8 }}>
            <thead style={{ textAlign: 'left', borderBottom: '1px solid #d7dce4' }}>
              <tr>
                <th style={{ padding: 8 }}>SKU</th>
                <th style={{ padding: 8 }}>Units</th>
                <th style={{ padding: 8 }}>Amount</th>
              </tr>
            </thead>
            <tbody>
              {Object.entries(meter.by_sku).map(([sku, v]) => (
                <tr key={sku} style={{ borderBottom: '1px solid #eef0f4' }}>
                  <td style={{ padding: 8, fontFamily: 'monospace' }}>{sku}</td>
                  <td style={{ padding: 8 }}>{v.units}</td>
                  <td style={{ padding: 8 }}>${v.amount.toFixed(4)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </div>
  );
}
