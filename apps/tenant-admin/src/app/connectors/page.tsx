import { Badge, Button, Card, PageHeader, cn } from '@projexlight/design-system';

interface InstallRow {
  vendor: string;
  install_id: string | null;
  status: string;
  last_synced_at: string | null;
  last_error: string | null;
  installed_at: string | null;
}

const TENANT_ID = process.env.TENANT_ADMIN_TENANT_ID ?? '';

const VENDORS = [
  { id: 'salesforce', label: 'Salesforce' },
  { id: 'microsoft365', label: 'Microsoft 365' },
  { id: 'gworkspace', label: 'Google Workspace' },
  { id: 'slack', label: 'Slack' },
  { id: 'jira', label: 'Jira' },
  { id: 'linear', label: 'Linear' },
  { id: 'zendesk', label: 'Zendesk' },
  { id: 'hubspot', label: 'HubSpot' },
  { id: 'zoom', label: 'Zoom' },
  { id: 'github', label: 'GitHub' },
  { id: 'snowflake', label: 'Snowflake' },
];

async function fetchInstalls(): Promise<InstallRow[]> {
  if (!TENANT_ID) return [];
  try {
    const res = await fetch(
      `${process.env.NEXT_PUBLIC_GATEWAY_URL}/api/connectors?tenant_id=${encodeURIComponent(TENANT_ID)}`,
      { cache: 'no-store' },
    );
    if (!res.ok) return [];
    return (await res.json()).data ?? [];
  } catch { return []; }
}

function statusClass(s: string): string {
  return s === 'connected' || s === 'active'
    ? 'bg-green-50 text-green-700 border-green-200'
    : s === 'expired' || s === 'error'
      ? 'bg-red-50 text-red-700 border-red-200'
      : 'bg-muted text-muted-foreground border-border';
}

export default async function ConnectorsPage(): Promise<JSX.Element> {
  const installs = await fetchInstalls();
  const byVendor = new Map(installs.map((i) => [i.vendor, i]));
  return (
    <div>
      <PageHeader
        title="Connectors"
        description="OAuth into your tools so ProjexCloud syncs data + posts back into them."
      />

      <div className="grid grid-cols-[repeat(auto-fit,minmax(240px,1fr))] gap-3">
        {VENDORS.map((v) => {
          const inst = byVendor.get(v.id);
          const status = inst?.status ?? 'not installed';
          return (
            <Card key={v.id} className="p-4">
              <div className="flex items-center justify-between">
                <strong>{v.label}</strong>
                <Badge variant="outline" className={cn('uppercase tracking-wide', statusClass(inst?.status ?? 'not-installed'))}>
                  {status}
                </Badge>
              </div>
              {inst?.last_synced_at && (
                <div className="mt-1.5 text-xs text-muted-foreground">
                  Last synced: {new Date(inst.last_synced_at).toLocaleString()}
                </div>
              )}
              {inst?.last_error && (
                <div className="mt-1.5 text-xs text-destructive">{inst.last_error}</div>
              )}
              <div className="mt-3">
                {inst ? (
                  <a
                    href={`${process.env.NEXT_PUBLIC_GATEWAY_URL}/api/connectors/${v.id}/refresh?tenant_id=${encodeURIComponent(TENANT_ID)}`}
                    className="text-[13px] text-primary hover:underline"
                  >
                    Refresh token
                  </a>
                ) : (
                  <Button asChild size="sm">
                    <a href={`${process.env.NEXT_PUBLIC_GATEWAY_URL}/api/connectors/${v.id}/install?tenant_id=${encodeURIComponent(TENANT_ID)}`}>
                      Connect
                    </a>
                  </Button>
                )}
              </div>
            </Card>
          );
        })}
      </div>
    </div>
  );
}
