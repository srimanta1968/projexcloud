import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { Alert, Button, Card, Field, Input, PageHeader, Select } from '@projexlight/design-system';
import { StatusBadge } from '../../components/StatusBadge';
import { gateway, GatewayError } from '../../lib/gateway';

/**
 * BYOK / CMEK (P8 Variant A; TK-4184). Every call goes out as the SIGNED-IN admin to the
 * tenant routes (/api/vault/byok/*), which take the tenant from the token. This screen used to
 * call the /admin routes with the platform ADMIN_OPS_TOKEN for a tenant id fixed in the app's
 * environment — every tenant admin acting with operator power on one hard-coded tenant.
 */

interface BindingRow {
  binding_id: string;
  tenant_id: string;
  provider: 'aws-kms' | 'gcp-kms' | 'hsm-pkcs11';
  customer_kms_key_arn: string;
  tenant_key_id: string;
  grant_status: 'active' | 'revoking' | 'revoked' | 'degraded';
  bound_at: string;
  revoked_at: string | null;
  sla_revoke_propagation_seconds: number;
  siem_forwarder_endpoint: string | null;
}

interface RotationRow {
  rotation_id: string;
  previous_tenant_key_id: string;
  new_tenant_key_id: string;
  started_at: string;
  completed_at: string | null;
}

type Loaded =
  | { kind: 'bound'; binding: BindingRow; rotations: RotationRow[] }
  | { kind: 'none' }
  | { kind: 'error'; message: string };

async function load(): Promise<Loaded> {
  try {
    const data = await gateway.get<{ binding: BindingRow; rotations: RotationRow[] }>('/api/vault/byok/binding');
    return { kind: 'bound', binding: data.binding, rotations: data.rotations ?? [] };
  } catch (err) {
    if (err instanceof GatewayError && err.status === 404) return { kind: 'none' };
    return { kind: 'error', message: err instanceof GatewayError ? err.message : 'the gateway could not be reached' };
  }
}

const done = (params: Record<string, string>): never => redirect(`/byok?${new URLSearchParams(params).toString()}`);
const failed = (err: unknown, fallback: string): string => (err instanceof GatewayError ? err.message : fallback);

async function bindCmkAction(formData: FormData): Promise<void> {
  'use server';
  let error = '';
  try {
    await gateway.post('/api/vault/byok/bindings', {
      provider: String(formData.get('provider') ?? ''),
      customer_kms_key_arn: String(formData.get('customer_kms_key_arn') ?? '').trim(),
      siem_forwarder_endpoint: String(formData.get('siem_forwarder_endpoint') ?? '').trim() || null,
    });
  } catch (err) {
    error = failed(err, 'Could not bind the CMK');
  }
  revalidatePath('/byok');
  done(error ? { error } : { notice: 'CMK bound. It now wraps this tenant’s key.' });
}

async function rotateAction(formData: FormData): Promise<void> {
  'use server';
  // Rotation is the routine operation and deliberately NOT in the danger zone: the tenant key
  // is replaced and the new one is wrapped by the SAME customer CMK, so data stays readable
  // and the previous key is superseded, not destroyed. One click; no key id to type.
  const binding_id = String(formData.get('binding_id') ?? '');
  let error = '';
  try {
    await gateway.post(`/api/vault/byok/bindings/${encodeURIComponent(binding_id)}/rotate`, {});
  } catch (err) {
    error = failed(err, 'Could not rotate');
  }
  revalidatePath('/byok');
  done(error ? { error } : { notice: 'Rotated. A new tenant key is wrapped by the same CMK; the rotation is listed below.' });
}

async function revokeAction(formData: FormData): Promise<void> {
  'use server';
  const binding_id = String(formData.get('binding_id') ?? '');
  const reason = String(formData.get('reason') ?? '').trim();
  if (formData.get('confirm_undecryptable') !== 'yes') done({ error: 'Confirm that you understand the data becomes undecryptable.' });
  let error = '';
  try {
    await gateway.post(`/api/vault/byok/bindings/${encodeURIComponent(binding_id)}/revoke`, { reason });
  } catch (err) {
    error = failed(err, 'Could not revoke');
  }
  revalidatePath('/byok');
  done(error ? { error } : { notice: 'Revoke started. The tenant’s data becomes undecryptable within the SLA shown.' });
}

export default async function ByokPage({ searchParams }: { searchParams: { error?: string; notice?: string } }): Promise<JSX.Element> {
  const state = await load();
  const binding = state.kind === 'bound' ? state.binding : null;
  const sla = binding?.sla_revoke_propagation_seconds ?? 30;
  return (
    <div>
      <PageHeader
        title="BYOK / CMEK"
        description={
          <>
            Bring-your-own-key (P8 Variant A). Your CMK wraps the Tenant Key.
            Revoking the grant on your CMK renders this tenant&apos;s data undecryptable
            within {sla}s — this is intentional and cannot be undone without re-binding.
          </>
        }
      />

      {searchParams.error ? <Alert variant="destructive" data-testid="byok-error">{searchParams.error}</Alert> : null}
      {searchParams.notice ? <Alert variant="success" data-testid="byok-notice">{searchParams.notice}</Alert> : null}

      {state.kind === 'error' && (
        <Alert variant="warning" data-testid="byok-unreachable">
          Could not read your CMK binding: {state.message}. This is not the same as having no binding — the gateway may be
          unreachable, or no KMS provider is configured in this environment.
        </Alert>
      )}

      {state.kind === 'bound' && binding && (
        <Card className="p-5" data-testid="byok-binding">
          <div className="flex items-center justify-between">
            <h2 className="text-lg font-semibold">Active binding</h2>
            <StatusBadge status={binding.grant_status} />
          </div>
          <dl className="mt-3 grid grid-cols-[160px_1fr] gap-x-3 gap-y-1.5 text-sm">
            <dt className="text-muted-foreground">Binding ID</dt><dd className="m-0 font-mono">{binding.binding_id}</dd>
            <dt className="text-muted-foreground">Provider</dt><dd className="m-0">{binding.provider}</dd>
            <dt className="text-muted-foreground">Customer key ARN</dt><dd className="m-0 break-all font-mono">{binding.customer_kms_key_arn}</dd>
            <dt className="text-muted-foreground">Tenant key ID</dt><dd className="m-0 font-mono">{binding.tenant_key_id}</dd>
            <dt className="text-muted-foreground">Bound at</dt><dd className="m-0">{new Date(binding.bound_at).toLocaleString()}</dd>
            <dt className="text-muted-foreground">Revoke SLA</dt><dd className="m-0">{binding.sla_revoke_propagation_seconds}s</dd>
            <dt className="text-muted-foreground">SIEM endpoint</dt><dd className="m-0">{binding.siem_forwarder_endpoint ?? <em>not configured</em>}</dd>
          </dl>

          {binding.grant_status === 'active' && (
            <form action={rotateAction} className="mt-4 rounded-md border border-border p-3">
              <input type="hidden" name="binding_id" value={binding.binding_id} />
              <p className="mb-2 text-sm text-muted-foreground">
                <strong className="text-foreground">Rotate the tenant key.</strong> Routine
                maintenance — a new tenant key is wrapped by the same customer CMK, so data stays
                readable throughout and the previous key is superseded, not destroyed.
              </p>
              <Button type="submit" data-testid="byok-rotate">Rotate CMK</Button>
            </form>
          )}

          <div className="mt-4" data-testid="byok-rotations">
            <h3 className="mb-1 text-sm font-semibold">Rotations</h3>
            {state.rotations.length === 0 ? (
              <p className="text-sm text-muted-foreground">No rotations yet.</p>
            ) : (
              <ul className="grid gap-1 text-xs">
                {state.rotations.map((r) => (
                  <li key={r.rotation_id} className="font-mono">
                    {new Date(r.started_at).toLocaleString()} · {r.previous_tenant_key_id.slice(0, 8)} → {r.new_tenant_key_id.slice(0, 8)}
                    {r.completed_at ? ' · completed' : ' · in progress'}
                  </li>
                ))}
              </ul>
            )}
          </div>

          {binding.grant_status === 'active' && (
            <form action={revokeAction} className="mt-4 rounded-md border border-destructive/40 bg-destructive/5 p-3">
              <input type="hidden" name="binding_id" value={binding.binding_id} />
              <p className="mb-2 text-destructive">
                <strong>Danger zone.</strong> Revoking the CMK grant renders ALL of this tenant&apos;s data undecryptable
                within <strong data-testid="byok-revoke-sla">{binding.sla_revoke_propagation_seconds} seconds</strong>, and it
                cannot be undone without re-binding.
              </p>
              <label className="mb-2 flex items-center gap-2 text-sm">
                <input type="checkbox" name="confirm_undecryptable" value="yes" required />
                I understand this tenant&apos;s data becomes undecryptable within {binding.sla_revoke_propagation_seconds} seconds.
              </label>
              <div className="flex gap-2">
                <Input name="reason" placeholder="reason (required)" required minLength={6} className="flex-1" />
                <Button type="submit" variant="danger">Revoke CMK binding</Button>
              </div>
            </form>
          )}
        </Card>
      )}

      {state.kind === 'none' && (
        <Card className="max-w-2xl p-5">
          <h2 className="mb-4 text-lg font-semibold">Bind a customer-managed key</h2>
          <form action={bindCmkAction} className="flex flex-col gap-3.5">
            <Field label="Provider" htmlFor="provider">
              <Select id="provider" name="provider" required>
                <option value="aws-kms">AWS KMS</option>
                <option value="gcp-kms">GCP KMS</option>
                <option value="hsm-pkcs11">HSM (PKCS#11)</option>
              </Select>
            </Field>
            <Field label="Customer KMS key ARN / handle" htmlFor="customer_kms_key_arn">
              <Input id="customer_kms_key_arn" name="customer_kms_key_arn" required />
            </Field>
            <p className="text-sm text-muted-foreground">Your CMK will wrap this tenant&apos;s own tenant key.</p>
            <Field label="SIEM forwarder endpoint (optional)" htmlFor="siem_forwarder_endpoint">
              <Input id="siem_forwarder_endpoint" name="siem_forwarder_endpoint" placeholder="https://siem.example.com/ingest" />
            </Field>
            <Button type="submit" className="justify-self-start self-start">Bind CMK</Button>
          </form>
        </Card>
      )}
    </div>
  );
}
