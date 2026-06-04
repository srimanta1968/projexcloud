import { revalidatePath } from 'next/cache';
import {
  Alert,
  Button,
  Card,
  Field,
  Input,
  Label,
  Select,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@projexlight/design-system';

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
  { id: 'openai', name: 'OpenAI (GPT-4o)' },
  { id: 'bedrock', name: 'AWS Bedrock' },
  { id: 'gemini', name: 'Google Gemini' },
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

export default async function AiProvidersPage(): Promise<JSX.Element> {
  const bindings = await fetchBindings();
  return (
    <div>
      <h1 className="text-2xl font-bold tracking-tight">AI Provider Keys (BYOK)</h1>
      <p className="mb-4 mt-1 max-w-2xl text-sm text-muted-foreground">
        Bring your own LLM provider keys. When a tenant credential is bound, the
        AI Gateway routes that tenant&apos;s completions through your key and
        suppresses our token-cost SKU — you pay your provider directly, and
        ProjexCloud bills only the governance per-call SKU.
      </p>

      <Alert variant="info" className="mb-5 border-l-[3px] border-l-brand">
        <strong>Billing note.</strong> When using your own provider key,
        ProjexCloud bills only the gateway governance SKU. Token costs go to
        your provider invoice. Revoking the binding immediately falls future
        completions back to the platform key (governance + token markup).
      </Alert>

      {!TENANT_ID && (
        <Alert variant="warning" className="mb-5">
          Set <code>TENANT_ADMIN_TENANT_ID</code> in this app&apos;s env to view your bindings.
        </Alert>
      )}

      <div className="rounded-lg border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Provider</TableHead>
              <TableHead>Source</TableHead>
              <TableHead>Last 4</TableHead>
              <TableHead>Bound at</TableHead>
              <TableHead>Allowlist</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {PROVIDERS.map((p) => {
              const active = activeBindingFor(bindings, p.id);
              return (
                <TableRow key={p.id}>
                  <TableCell>{p.name}</TableCell>
                  <TableCell>
                    {active ? (
                      <span className="font-semibold text-success">tenant binding</span>
                    ) : (
                      <span className="text-muted-foreground">platform fallback</span>
                    )}
                  </TableCell>
                  <TableCell className="font-mono">{active ? `…${active.last_4}` : '—'}</TableCell>
                  <TableCell>{active ? new Date(active.bound_at).toLocaleString() : '—'}</TableCell>
                  <TableCell className="text-xs">
                    {active?.model_allowlist?.join(', ') ?? <em className="text-muted-foreground">all models</em>}
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </div>

      {TENANT_ID && (
        <>
          <Card className="mt-4 max-w-2xl p-5">
            <h2 className="text-base font-semibold">Bind a key</h2>
            <p className="mb-4 mt-1 text-[13px] text-muted-foreground">
              Existing active bindings for the same provider are revoked atomically when a new bind succeeds.
            </p>
            <form action={bindAction} className="flex flex-col gap-3.5">
              <Field label="Provider" htmlFor="provider_id">
                <Select id="provider_id" name="provider_id" required defaultValue="openai">
                  {PROVIDERS.map((p) => (
                    <option key={p.id} value={p.id}>{p.name}</option>
                  ))}
                </Select>
              </Field>
              <Field label="Raw API key (write-only; only last 4 displayed after save)" htmlFor="raw_key">
                <Input id="raw_key" name="raw_key" type="password" required minLength={8} autoComplete="off" />
              </Field>
              <Field label="Model allowlist (comma-separated, leave blank for all)" htmlFor="model_allowlist">
                <Input id="model_allowlist" name="model_allowlist" type="text" placeholder="gpt-4o, gpt-4o-mini" />
              </Field>
              <Label className="flex items-center gap-2">
                <input type="checkbox" name="fallback_on_error" defaultChecked className="h-4 w-4" />
                Fall back to platform credential on provider errors
              </Label>
              <Button type="submit" className="justify-self-start self-start">Bind key</Button>
            </form>
          </Card>

          {bindings.filter((b) => b.status === 'active').map((b) => (
            <Card key={b.binding_id} className="mt-4 max-w-2xl bg-muted p-5">
              <h3 className="text-[15px] font-semibold">
                {b.provider_id} — <code>{b.binding_id}</code>
              </h3>

              <form action={rotateAction} className="mt-3 flex items-center gap-2">
                <input type="hidden" name="binding_id" value={b.binding_id} />
                <Input name="raw_key" type="password" placeholder="new raw key" required minLength={8} autoComplete="off" className="flex-1" />
                <Button type="submit" className="bg-brand text-brand-foreground hover:bg-brand/90">Rotate</Button>
              </form>

              <form action={revokeAction} className="mt-3 rounded-md border border-destructive/40 bg-destructive/5 p-3">
                <input type="hidden" name="binding_id" value={b.binding_id} />
                <p className="mb-2 text-[13px] text-destructive">
                  <strong>Danger zone.</strong> Revoking falls future completions back to the platform credential
                  (and the token-cost SKU starts billing again). Type a reason ≥ 6 characters to confirm.
                </p>
                <div className="flex gap-2">
                  <Input name="reason" type="text" placeholder="reason (required, min 6 chars)" required minLength={6} className="flex-1" />
                  <Button type="submit" variant="danger">Revoke</Button>
                </div>
              </form>
            </Card>
          ))}
        </>
      )}
    </div>
  );
}
