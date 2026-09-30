import { Alert, Badge, Card, PageHeader, Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@projexlight/design-system';
import { opsGateway, OpsGatewayError } from '../../../lib/opsGateway';

/**
 * Voice capacity (VA·E9 · TK-4516): per-tenant active AI calls and where each tenant stands
 * against its plan concurrency cap — the numbers the dialer enforces. Tenants at their 80 %
 * alert point, or at the cap (new calls refused), are flagged. Refreshes on every load.
 */

interface TenantCapacity {
  tenant_id: string;
  active_calls: number;
  by_status: { dialing: number; ringing: number; in_progress: number; transferred: number };
  test_calls: number;
  slots_in_use: number;
  plan_cap: number | null;
  alert_at: number | null;
  at_alert: boolean;
  at_cap: boolean;
  backend: string;
  campaigns: { running: number; paused: number };
}
interface Capacity { totals: { tenants: number; active_calls: number; at_alert: number; at_cap: number }; tenants: TenantCapacity[] }
interface Tenant { tenant_id: string; display_name?: string | null }

export const dynamic = 'force-dynamic';

export default async function CapacityPage() {
  let data: Capacity | null = null;
  let names = new Map<string, string>();
  let error: string | undefined;
  try {
    data = await opsGateway.get<Capacity>('/api/admin/voice/capacity');
    const t = await opsGateway.get<{ tenants: Tenant[] }>('/admin/tenants').catch(() => ({ tenants: [] as Tenant[] }));
    names = new Map(t.tenants.map((x) => [x.tenant_id, x.display_name ?? x.tenant_id]));
  } catch (err) {
    error = err instanceof OpsGatewayError ? err.message : 'Could not load capacity';
  }
  return (
    <div>
      <PageHeader title="Voice capacity" description="Active AI calls per tenant against each tenant's plan concurrency cap." />
      {error ? <Alert variant="destructive" data-testid="capacity-error">{error}</Alert> : null}
      {data ? (
        <>
          <div className="mb-4 grid grid-cols-2 gap-3 md:grid-cols-4" data-testid="capacity-totals">
            <Card className="p-3"><div className="text-xs text-muted-foreground">Active calls</div><div className="text-2xl font-semibold" data-testid="total-active">{data.totals.active_calls}</div></Card>
            <Card className="p-3"><div className="text-xs text-muted-foreground">Tenants with load</div><div className="text-2xl font-semibold">{data.totals.tenants}</div></Card>
            <Card className="p-3"><div className="text-xs text-muted-foreground">At 80 % alert</div><div className="text-2xl font-semibold" data-testid="total-alert">{data.totals.at_alert}</div></Card>
            <Card className="p-3"><div className="text-xs text-muted-foreground">At cap</div><div className="text-2xl font-semibold" data-testid="total-cap">{data.totals.at_cap}</div></Card>
          </div>
          <div className="rounded-lg border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Tenant</TableHead>
                  <TableHead className="text-right">Active</TableHead>
                  <TableHead>Dialing · ringing · talking · transferred</TableHead>
                  <TableHead>Capacity (slots / cap, alert at)</TableHead>
                  <TableHead>Campaigns</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.tenants.length === 0 ? <TableRow><TableCell colSpan={5} className="text-muted-foreground" data-testid="capacity-empty">No voice activity right now.</TableCell></TableRow> : null}
                {data.tenants.map((t) => (
                  <TableRow key={t.tenant_id} data-testid={`tenant-${t.tenant_id}`}>
                    <TableCell>
                      <div>{names.get(t.tenant_id) ?? t.tenant_id}</div>
                      <div className="font-mono text-[11px] text-muted-foreground">{t.tenant_id}</div>
                    </TableCell>
                    <TableCell className="text-right tabular-nums">{t.active_calls}{t.test_calls ? <span className="text-xs text-muted-foreground"> ({t.test_calls} test)</span> : null}</TableCell>
                    <TableCell className="tabular-nums">{t.by_status.dialing} · {t.by_status.ringing} · {t.by_status.in_progress} · {t.by_status.transferred}</TableCell>
                    <TableCell>
                      <span className="tabular-nums">{t.slots_in_use} / {t.plan_cap ?? '∞'}</span>
                      {t.alert_at !== null ? <span className="text-xs text-muted-foreground"> (alert at {t.alert_at})</span> : null}{' '}
                      {t.at_cap ? <Badge variant="destructive">at cap</Badge> : t.at_alert ? <Badge variant="warning">80 %</Badge> : null}
                    </TableCell>
                    <TableCell>{t.campaigns.running} running{t.campaigns.paused ? `, ${t.campaigns.paused} paused` : ''}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </>
      ) : null}
    </div>
  );
}
