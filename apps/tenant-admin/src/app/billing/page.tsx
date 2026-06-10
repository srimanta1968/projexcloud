import {
  Alert,
  Card,
  PageHeader,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@projexlight/design-system';

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
      <PageHeader
        title="Billing"
        description="Live meter — current period accrual updated within ≈60s of meter ingest (FR-BIL-7)."
      />

      {!meter && (
        <Alert variant="warning">
          Gateway unreachable or tenant has no current-period usage.
        </Alert>
      )}

      {meter && (
        <>
          <div className="mt-2 flex gap-4">
            <Card className="flex-1 p-5">
              <div className="text-xs text-muted-foreground">Subtotal (since {meter.current_period_start})</div>
              <div className="text-3xl font-bold">${meter.subtotal.toFixed(2)}</div>
            </Card>
            <Card className="flex-1 p-5">
              <div className="text-xs text-muted-foreground">Meter lag</div>
              <div className="text-3xl font-bold">{meter.lag_ms}ms</div>
            </Card>
          </div>

          <h2 className="mb-3 mt-8 text-lg font-semibold">By SKU</h2>
          <div className="rounded-lg border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>SKU</TableHead>
                  <TableHead>Units</TableHead>
                  <TableHead>Amount</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {Object.entries(meter.by_sku).map(([sku, v]) => (
                  <TableRow key={sku}>
                    <TableCell className="font-mono text-xs">{sku}</TableCell>
                    <TableCell className="tabular-nums">{v.units}</TableCell>
                    <TableCell className="tabular-nums">${v.amount.toFixed(4)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </>
      )}
    </div>
  );
}
