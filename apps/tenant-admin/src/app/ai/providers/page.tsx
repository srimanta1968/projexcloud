import { revalidatePath } from 'next/cache';

/**
 * Tenant-BYOK for AI Provider Keys — admin surface (FR-BYOK-10..14).
 *
 * Lists the four supported LLM providers (Anthropic, OpenAI, Bedrock,
 * Gemini), shows whether each is bound to a tenant credential or falling
 * back to the platform key, and exposes bind / rotate / revoke flows.
 *
 * Security invariants enforced by the gateway and mirrored here:
 *   - Raw keys are submitted via type=password inputs and never re-rendered.
 *   - GET only returns last_4 + lifecycle metadata.
 *   - Revoke requires a typed reason >= 6 chars (mirrors the CMEK BYOK page).
 */

const TENANT_ID = process.env.TENANT_ADMIN_TENANT_ID ?? '';

type ProviderId = 'anthropic' | 'openai' | 'bedrock' | 'gemini';

const PROVIDERS: Array<{ id: ProviderId; name: string }> = [
  { id: 'anthropic', name: 'Anthropic (Claude)' },
  { id: 'openai',    name: 'OpenAI (GPT-4o)' },
  { id: 'bedrock',   name: 'AWS Bedrock' },
  { id: 'gemini',    name: 'Google Gemini' },
];

interface BindingRow {
  binding_id: string;
  tenant_id: string;
  provider_id: ProviderId;
  status: 'active' | 'revoked';
  model_allowlist: string[] | null;
  last_4: string;
  fallback_on_error: boolean;
  bound_at: string;
  revoked_at: string | null;
}

async function fetchBindings(): Promise<BindingRow[]> {
  if (!TENANT_ID) return [];
  try {
    const res = await fetch(
      `${process.env.NEXT_PUBLIC_GATEWAY_URL}/api/ai-gateway/tenant-credentials?tenant_id=${encodeURIComponent(TENANT_ID)}`,
      { cache: 'no-store' },
    );
    if (!res.ok) return [];
    const body = await res.json();
    return body?.data?.bindings ?? [];
  } catch {
    return [];
  }
}

function activeBindingFor(rows: BindingRow[], provider_id: ProviderId): BindingRow | undefined {
  return rows.find((r) => r.provider_id === provider_id && r.status === 'active');
}

async function bindAction(formData: FormData): Promise<void> {
  'use server';
  const provider_id = String(formData.get('provider_id') ?? '');
  const raw_key = String(formData.get('raw_key') ?? '');
  const allowlist_raw = String(formData.get('model_allowlist') ?? '').trim();
  const fallback_on_error = formData.get('fallback_on_error') === 'on';
  if (!provider_id || !raw_key) return;
  const model_allowlist = allowlist_raw
    ? allowlist_raw.split(',').map((s) => s.trim()).filter((s) => s.length > 0)
    : undefined;
  await fetch(`${process.env.NEXT_PUBLIC_GATEWAY_URL}/api/ai-gateway/tenant-credentials`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      tenant_id: TENANT_ID,
      provider_id,
      raw_key,
      model_allowlist,
      fallback_on_error,
    }),
  });
  revalidatePath('/ai/providers');
}

async function rotateAction(formData: FormData): Promise<void> {
  'use server';
  const binding_id = String(formData.get('binding_id') ?? '');
  const raw_key = String(formData.get('raw_key') ?? '');
  if (!binding_id || !raw_key) return;
  await fetch(
    `${process.env.NEXT_PUBLIC_GATEWAY_URL}/api/ai-gateway/tenant-credentials/${encodeURIComponent(binding_id)}`,
    {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ raw_key }),
    },
  );
  revalidatePath('/ai/providers');
}

async function revokeAction(formData: FormData): Promise<void> {
  'use server';
  const binding_id = String(formData.get('binding_id') ?? '');
  const reason = String(formData.get('reason') ?? '').trim();
  if (!binding_id || reason.length < 6) return;
  await fetch(
    `${process.env.NEXT_PUBLIC_GATEWAY_URL}/api/ai-gateway/tenant-credentials/${encodeURIComponent(binding_id)}`,
    {
      method: 'DELETE',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ reason }),
    },
  );
  revalidatePath('/ai/providers');
}

const BANNER: React.CSSProperties = {
  background: '#ecf2fc',
  border: '1px solid #b9c3d6',
  borderLeft: '3px solid #1a4fc4',
  padding: '12px 14px',
  borderRadius: 4,
  fontSize: 14,
  marginBottom: 20,
  color: '#1b2a44',
};

const SECTION: React.CSSProperties = {
  marginTop: 16,
  padding: 16,
  border: '1px solid #d7dce4',
  borderRadius: 8,
};

const LABEL: React.CSSProperties = { display: 'block', marginBottom: 4, fontSize: 13, color: '#5a6573' };
const INPUT: React.CSSProperties = { display: 'block', width: '100%', padding: 6, marginBottom: 12, boxSizing: 'border-box' };

export default async function AiProvidersPage(): Promise<JSX.Element> {
  const bindings = await fetchBindings();
  return (
    <div>
      <h1>AI Provider Keys (BYOK)</h1>
      <p style={{ color: '#5a6573', maxWidth: 760 }}>
        Bring your own LLM provider keys. When a tenant credential is bound, the
        AI Gateway routes that tenant&apos;s completions through your key and
        suppresses our token-cost SKU — you pay your provider directly, and
        ProjexCloud bills only the governance per-call SKU.
      </p>

      <div style={BANNER}>
        <strong>Billing note.</strong> When using your own provider key,
        ProjexCloud bills only the gateway governance SKU. Token costs go to
        your provider invoice. Revoking the binding immediately falls future
        completions back to the platform key (governance + token markup).
      </div>

      {!TENANT_ID && (
        <div style={{ background: '#fff4d6', border: '1px solid #e3c47b', padding: 12, borderRadius: 4, marginBottom: 20 }}>
          Set <code>TENANT_ADMIN_TENANT_ID</code> in this app&apos;s env to view your bindings.
        </div>
      )}

      <table style={{ width: '100%', borderCollapse: 'collapse', marginTop: 12, fontSize: 14 }}>
        <thead>
          <tr style={{ background: '#f1f5fb', textAlign: 'left' }}>
            <th style={{ padding: 8, borderBottom: '1px solid #d3dbe8' }}>Provider</th>
            <th style={{ padding: 8, borderBottom: '1px solid #d3dbe8' }}>Source</th>
            <th style={{ padding: 8, borderBottom: '1px solid #d3dbe8' }}>Last 4</th>
            <th style={{ padding: 8, borderBottom: '1px solid #d3dbe8' }}>Bound at</th>
            <th style={{ padding: 8, borderBottom: '1px solid #d3dbe8' }}>Allowlist</th>
          </tr>
        </thead>
        <tbody>
          {PROVIDERS.map((p) => {
            const active = activeBindingFor(bindings, p.id);
            return (
              <tr key={p.id}>
                <td style={{ padding: 8, borderBottom: '1px solid #eef1f6' }}>{p.name}</td>
                <td style={{ padding: 8, borderBottom: '1px solid #eef1f6' }}>
                  {active ? (
                    <span style={{ color: '#0d8a3d', fontWeight: 600 }}>tenant binding</span>
                  ) : (
                    <span style={{ color: '#5a6573' }}>platform fallback</span>
                  )}
                </td>
                <td style={{ padding: 8, borderBottom: '1px solid #eef1f6', fontFamily: 'monospace' }}>
                  {active ? `…${active.last_4}` : '—'}
                </td>
                <td style={{ padding: 8, borderBottom: '1px solid #eef1f6' }}>
                  {active ? new Date(active.bound_at).toLocaleString() : '—'}
                </td>
                <td style={{ padding: 8, borderBottom: '1px solid #eef1f6', fontSize: 13 }}>
                  {active?.model_allowlist?.join(', ') ?? <em style={{ color: '#7a8597' }}>all models</em>}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>

      {/* Bind / rotate / revoke forms */}
      {TENANT_ID && (
        <>
          <section style={SECTION}>
            <h2 style={{ marginTop: 0, fontSize: 16 }}>Bind a key</h2>
            <p style={{ color: '#5a6573', fontSize: 13, marginTop: 4 }}>
              Existing active bindings for the same provider are revoked atomically when a new bind succeeds.
            </p>
            <form action={bindAction} style={{ maxWidth: 560 }}>
              <label style={LABEL}>Provider</label>
              <select name="provider_id" required style={INPUT} defaultValue="openai">
                {PROVIDERS.map((p) => (
                  <option key={p.id} value={p.id}>{p.name}</option>
                ))}
              </select>

              <label style={LABEL}>Raw API key (write-only; only last 4 displayed after save)</label>
              <input name="raw_key" type="password" required minLength={8} autoComplete="off" style={INPUT} />

              <label style={LABEL}>Model allowlist (comma-separated, leave blank for all)</label>
              <input name="model_allowlist" type="text" placeholder="gpt-4o, gpt-4o-mini" style={INPUT} />

              <label style={{ fontSize: 13, display: 'flex', alignItems: 'center', gap: 6, marginBottom: 12 }}>
                <input type="checkbox" name="fallback_on_error" defaultChecked />
                Fall back to platform credential on provider errors
              </label>

              <button type="submit" style={{ padding: '8px 16px', background: '#1b2a44', color: 'white', border: 'none', borderRadius: 4 }}>
                Bind key
              </button>
            </form>
          </section>

          {bindings.filter((b) => b.status === 'active').map((b) => (
            <section key={b.binding_id} style={{ ...SECTION, background: '#fafbfd' }}>
              <h3 style={{ marginTop: 0, fontSize: 15 }}>
                {b.provider_id} — <code>{b.binding_id}</code>
              </h3>

              <form action={rotateAction} style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 12 }}>
                <input type="hidden" name="binding_id" value={b.binding_id} />
                <input
                  name="raw_key"
                  type="password"
                  placeholder="new raw key"
                  required
                  minLength={8}
                  autoComplete="off"
                  style={{ flex: 1, padding: 6 }}
                />
                <button type="submit" style={{ padding: '6px 14px', background: '#1a4fc4', color: 'white', border: 'none', borderRadius: 4 }}>
                  Rotate
                </button>
              </form>

              <form action={revokeAction} style={{ padding: 10, background: '#fff5f5', border: '1px solid #e3a8a8', borderRadius: 4 }}>
                <input type="hidden" name="binding_id" value={b.binding_id} />
                <p style={{ marginTop: 0, color: '#a31818', fontSize: 13 }}>
                  <strong>Danger zone.</strong> Revoking falls future completions back to the platform credential
                  (and the token-cost SKU starts billing again). Type a reason ≥ 6 characters to confirm.
                </p>
                <div style={{ display: 'flex', gap: 8 }}>
                  <input
                    name="reason"
                    type="text"
                    placeholder="reason (required, min 6 chars)"
                    required
                    minLength={6}
                    style={{ flex: 1, padding: 6 }}
                  />
                  <button type="submit" style={{ padding: '6px 14px', background: '#a31818', color: 'white', border: 'none', borderRadius: 4 }}>
                    Revoke
                  </button>
                </div>
              </form>
            </section>
          ))}
        </>
      )}
    </div>
  );
}
