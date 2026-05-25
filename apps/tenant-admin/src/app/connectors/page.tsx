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
  { id: 'salesforce',   label: 'Salesforce' },
  { id: 'microsoft365', label: 'Microsoft 365' },
  { id: 'gworkspace',   label: 'Google Workspace' },
  { id: 'slack',        label: 'Slack' },
  { id: 'jira',         label: 'Jira' },
  { id: 'linear',       label: 'Linear' },
  { id: 'zendesk',      label: 'Zendesk' },
  { id: 'hubspot',      label: 'HubSpot' },
  { id: 'zoom',         label: 'Zoom' },
  { id: 'github',       label: 'GitHub' },
  { id: 'snowflake',    label: 'Snowflake' },
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

function statusColor(s: string): string {
  return s === 'connected' || s === 'active' ? '#0d8a3d'
    : s === 'expired' || s === 'error' ? '#a31818'
    : '#5a6573';
}

export default async function ConnectorsPage(): Promise<JSX.Element> {
  const installs = await fetchInstalls();
  const byVendor = new Map(installs.map((i) => [i.vendor, i]));
  return (
    <div>
      <h1>Connectors</h1>
      <p style={{ color: '#5a6573' }}>OAuth into your tools so ProjexCloud syncs data + posts back into them.</p>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: 12, marginTop: 16 }}>
        {VENDORS.map((v) => {
          const inst = byVendor.get(v.id);
          return (
            <div key={v.id} style={{ padding: 12, border: '1px solid #d7dce4', borderRadius: 8 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <strong>{v.label}</strong>
                <span style={{ fontSize: 11, color: statusColor(inst?.status ?? 'not-installed'), fontWeight: 600 }}>
                  {inst?.status ?? 'not installed'}
                </span>
              </div>
              {inst?.last_synced_at && (
                <div style={{ fontSize: 12, color: '#5a6573', marginTop: 6 }}>
                  Last synced: {new Date(inst.last_synced_at).toLocaleString()}
                </div>
              )}
              {inst?.last_error && (
                <div style={{ fontSize: 12, color: '#a31818', marginTop: 6 }}>{inst.last_error}</div>
              )}
              <div style={{ marginTop: 12 }}>
                {inst ? (
                  <a
                    href={`${process.env.NEXT_PUBLIC_GATEWAY_URL}/api/connectors/${v.id}/refresh?tenant_id=${encodeURIComponent(TENANT_ID)}`}
                    style={{ fontSize: 13, color: '#1b2a44' }}
                  >
                    Refresh token
                  </a>
                ) : (
                  <a
                    href={`${process.env.NEXT_PUBLIC_GATEWAY_URL}/api/connectors/${v.id}/install?tenant_id=${encodeURIComponent(TENANT_ID)}`}
                    style={{
                      display: 'inline-block',
                      padding: '6px 12px',
                      background: '#1b2a44',
                      color: 'white',
                      borderRadius: 4,
                      textDecoration: 'none',
                      fontSize: 13,
                    }}
                  >
                    Connect
                  </a>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
