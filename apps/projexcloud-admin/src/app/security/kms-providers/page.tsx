import { cookies } from 'next/headers';
import { Alert, Card, PageHeader } from '@projexlight/design-system';
import { SESSION_COOKIE } from '@projexlight/design-system/auth';

/**
 * KMS provider configuration — platform, tenant and app scope.
 *
 * THE POINT OF THIS SCREEN IS THAT CONFIG AND REALITY DISAGREE.
 *
 * A config row naming "aws-kms" is INTENT. Whether AWS credentials actually reached the
 * gateway process is a separate fact, and the two came apart badly here: production ran
 * for weeks with a config that said BYOK and a runtime that was simulating it, because
 * the provider registry substituted a synthetic stand-in whenever real credentials were
 * missing — silently, with no log line and behind no flag. "Revoke makes tenant data
 * undecryptable" was unbacked the entire time and every screen said it was fine.
 *
 * So this renders both: what is configured, and what is serving calls right now. When
 * they disagree the runtime column is the truth.
 *
 * CREDENTIALS ARE NOT EDITABLE HERE, deliberately. They arrive as process environment
 * (AWS_ACCESS_KEY_ID, GOOGLE_APPLICATION_CREDENTIALS, HSM_PKCS11_LIB…), which a web
 * page cannot write without the server holding a mechanism to rewrite its own
 * environment and restart — a far larger attack surface than the problem deserves. The
 * screen names exactly which variables to set instead.
 */

interface KmsStatus {
  kind: 'aws-kms' | 'gcp-kms' | 'hsm-pkcs11';
  credentialsPresent: boolean;
  mode: 'real' | 'synthetic' | 'unregistered';
  wiredBy: string[];
}

interface ConfigRow {
  config_id: string;
  scope: string;
  scope_id: string;
  key: string;
  value: Record<string, unknown> | null;
  secret_ref: string | null;
  status: string;
}

const GATEWAY = process.env.NEXT_PUBLIC_GATEWAY_URL ?? '';
const OPS_TOKEN = process.env.ADMIN_OPS_TOKEN ?? '';

async function fetchStatus(): Promise<KmsStatus[] | null> {
  try {
    const res = await fetch(`${GATEWAY}/admin/vault/kms-status`, {
      cache: 'no-store',
      headers: { 'x-admin-ops-token': OPS_TOKEN },
    });
    if (!res.ok) return null;
    return (await res.json()).data ?? [];
  } catch {
    return null;
  }
}

/** KMS config rows at every scope, so the inheritance chain is visible in one place. */
async function fetchKmsConfig(): Promise<ConfigRow[]> {
  const jwt = cookies().get(SESSION_COOKIE)?.value ?? '';
  const scopes = ['platform', 'tenant', 'app'];
  const all = await Promise.all(
    scopes.map(async (scope) => {
      try {
        const res = await fetch(`${GATEWAY}/api/config?scope=${scope}`, {
          cache: 'no-store',
          headers: { Authorization: `Bearer ${jwt}` },
        });
        if (!res.ok) return [] as ConfigRow[];
        const rows: ConfigRow[] = (await res.json()).data ?? [];
        return rows.filter((r) => r.key.startsWith('vault.kms'));
      } catch {
        return [] as ConfigRow[];
      }
    }),
  );
  return all.flat();
}

function ModeBadge({ mode }: { mode: KmsStatus['mode'] }): JSX.Element {
  const map = {
    real: { tone: 'bg-emerald-500/15 text-emerald-700', label: 'real' },
    synthetic: { tone: 'bg-amber-500/15 text-amber-700', label: 'synthetic' },
    unregistered: { tone: 'bg-destructive/15 text-destructive', label: 'unregistered' },
  } as const;
  const m = map[mode];
  return <span className={`rounded px-2 py-0.5 text-xs font-medium ${m.tone}`}>{m.label}</span>;
}

export default async function KmsProvidersPage(): Promise<JSX.Element> {
  const [status, config] = await Promise.all([fetchStatus(), fetchKmsConfig()]);
  const synthetic = (status ?? []).filter((s) => s.mode === 'synthetic');
  const unregistered = (status ?? []).filter((s) => s.mode === 'unregistered');

  return (
    <div>
      <PageHeader
        title="KMS providers"
        description={
          <>
            Which key-management service wraps platform-owned keys, and what is actually
            serving calls right now. Configuration is intent; the runtime column is the
            truth, and when they differ the runtime column wins.
          </>
        }
      />

      {status === null && (
        <Alert variant="warning">
          Could not read provider status — the gateway is unreachable or{' '}
          <code>ADMIN_OPS_TOKEN</code> is not set for this console. Nothing below reflects
          the running system.
        </Alert>
      )}

      {synthetic.length > 0 && (
        <Alert variant="warning">
          <strong>
            {synthetic.length} provider{synthetic.length === 1 ? ' is' : 's are'} synthetic.
          </strong>{' '}
          Calls succeed against a simulation: nothing is really wrapped, and revoking a
          customer key would not make their data undecryptable. Acceptable on a developer
          machine and nowhere else — if this is a deployed environment, set{' '}
          <code>APP_ENV=qa|staging|production</code> so the substitution is refused, then
          wire real credentials.
        </Alert>
      )}

      {unregistered.length > 0 && (
        <Alert variant="warning">
          {unregistered.length} provider{unregistered.length === 1 ? '' : 's'} refused to
          register because this environment is protected and no real credentials were
          found. BYOK calls for {unregistered.length === 1 ? 'it' : 'them'} will fail —
          which is the intended behaviour, not a fault. Wire the variables listed below.
        </Alert>
      )}

      <Card className="p-5">
        <h2 className="mb-3 text-lg font-semibold">Runtime</h2>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b text-left text-xs uppercase tracking-wide text-muted-foreground">
                <th className="py-2 pr-3">Provider</th>
                <th className="py-2 pr-3">Serving</th>
                <th className="py-2 pr-3">Credentials</th>
                <th className="py-2">Wired by</th>
              </tr>
            </thead>
            <tbody>
              {(status ?? []).map((s) => (
                <tr key={s.kind} className="border-b last:border-0">
                  <td className="py-2 pr-3 font-mono text-xs">{s.kind}</td>
                  <td className="py-2 pr-3"><ModeBadge mode={s.mode} /></td>
                  <td className="py-2 pr-3">
                    {s.credentialsPresent
                      ? <span className="text-emerald-700">present</span>
                      : <span className="text-muted-foreground">absent</span>}
                  </td>
                  <td className="py-2 font-mono text-xs text-muted-foreground">
                    {s.wiredBy.join(', ')}
                  </td>
                </tr>
              ))}
              {(status ?? []).length === 0 && (
                <tr><td colSpan={4} className="py-3 text-sm text-muted-foreground">No provider status available.</td></tr>
              )}
            </tbody>
          </table>
        </div>
        <p className="mt-3 text-xs text-muted-foreground">
          Credentials are process environment and cannot be edited from this page — a
          server able to rewrite its own environment is a larger risk than the
          convenience is worth. Set them where the service is deployed and restart.
        </p>
      </Card>

      <Card className="mt-4 p-5">
        <h2 className="mb-1 text-lg font-semibold">Configured intent</h2>
        <p className="mb-3 text-sm text-muted-foreground">
          <code>vault.kms</code> rows, resolved most-specific-first: app overrides tenant,
          tenant overrides platform. Edit these under Config.
        </p>
        {config.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No <code>vault.kms</code> configured at any scope — platform keys fall back to
            whatever the runtime has wired above.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-left text-xs uppercase tracking-wide text-muted-foreground">
                  <th className="py-2 pr-3">Scope</th>
                  <th className="py-2 pr-3">Scope id</th>
                  <th className="py-2 pr-3">Key</th>
                  <th className="py-2 pr-3">Value</th>
                  <th className="py-2">Status</th>
                </tr>
              </thead>
              <tbody>
                {config.map((c) => (
                  <tr key={c.config_id} className="border-b last:border-0">
                    <td className="py-2 pr-3">{c.scope}</td>
                    <td className="py-2 pr-3 font-mono text-xs break-all">{c.scope_id || '—'}</td>
                    <td className="py-2 pr-3 font-mono text-xs">{c.key}</td>
                    <td className="py-2 pr-3 font-mono text-xs break-all">
                      {/* secret_ref, never the secret. A config row that could render a
                          credential would put it in every screenshot and log. */}
                      {c.secret_ref ? <em className="text-muted-foreground">secret ({c.secret_ref})</em> : JSON.stringify(c.value)}
                    </td>
                    <td className="py-2">{c.status}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}
