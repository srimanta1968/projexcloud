import { revalidatePath } from 'next/cache';
import { Alert, Button, Card, Field, Input, PageHeader, Select } from '@projexlight/design-system';
import { StatusBadge } from '../../components/StatusBadge';

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

const TENANT_ID = process.env.TENANT_ADMIN_TENANT_ID ?? '';

async function fetchBinding(): Promise<BindingRow | null> {
  if (!TENANT_ID) return null;
  try {
    const res = await fetch(
      `${process.env.NEXT_PUBLIC_GATEWAY_URL}/admin/byok/bindings/tenant/${encodeURIComponent(TENANT_ID)}`,
      {
        cache: 'no-store',
        headers: { 'x-admin-ops-token': process.env.ADMIN_OPS_TOKEN ?? '' },
      },
    );
    if (!res.ok) return null;
    const body = await res.json();
    return body.data ?? null;
  } catch {
    return null;
  }
}

async function bindCmkAction(formData: FormData): Promise<void> {
  'use server';
  const provider = String(formData.get('provider') ?? '');
  const customer_kms_key_arn = String(formData.get('customer_kms_key_arn') ?? '');
  const tenant_key_id = String(formData.get('tenant_key_id') ?? '');
  const siem_forwarder_endpoint = String(formData.get('siem_forwarder_endpoint') ?? '').trim() || null;
  await fetch(`${process.env.NEXT_PUBLIC_GATEWAY_URL}/admin/byok/bindings`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-admin-ops-token': process.env.ADMIN_OPS_TOKEN ?? '',
    },
    body: JSON.stringify({
      tenant_id: TENANT_ID,
      provider,
      customer_kms_key_arn,
      tenant_key_id,
      siem_forwarder_endpoint,
      operator_id: 'tenant-admin-ui',
    }),
  });
  revalidatePath('/byok');
}

async function rotateAction(formData: FormData): Promise<void> {
  'use server';
  // ROTATION IS THE ROUTINE OPERATION, and it was the one this screen could not do.
  //
  // Bind and Revoke were here from the start; rotate was not, although
  // /admin/byok/bindings/:id/rotate has always existed and vault.cmk_rotation was
  // accumulating rows. So an operator could set a key up and could destroy access in
  // an emergency, but the thing you actually do on a schedule — roll the tenant key
  // under the same customer CMK — had no path outside curl.
  //
  // It is deliberately NOT in the danger zone: rotating keeps data readable (the new
  // tenant key is wrapped by the same CMK, and the old one is superseded rather than
  // shredded). Presenting it beside Revoke in red would teach operators to hesitate
  // over the safe operation and habituate them to the destructive one.
  const binding_id = String(formData.get('binding_id') ?? '');
  const previous_tenant_key_id = String(formData.get('previous_tenant_key_id') ?? '');
  const new_tenant_key_id = String(formData.get('new_tenant_key_id') ?? '').trim();
  if (!binding_id || !new_tenant_key_id) return;
  await fetch(
    `${process.env.NEXT_PUBLIC_GATEWAY_URL}/admin/byok/bindings/${encodeURIComponent(binding_id)}/rotate`,
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-admin-ops-token': process.env.ADMIN_OPS_TOKEN ?? '',
      },
      body: JSON.stringify({
        previous_tenant_key_id,
        new_tenant_key_id,
        operator_id: 'tenant-admin-ui',
      }),
    },
  );
  revalidatePath('/byok');
}

async function revokeAction(formData: FormData): Promise<void> {
  'use server';
  const binding_id = String(formData.get('binding_id') ?? '');
  const reason = String(formData.get('reason') ?? '').trim();
  if (!reason) return;
  await fetch(
    `${process.env.NEXT_PUBLIC_GATEWAY_URL}/admin/byok/bindings/${encodeURIComponent(binding_id)}/revoke`,
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-admin-ops-token': process.env.ADMIN_OPS_TOKEN ?? '',
      },
      body: JSON.stringify({ reason, operator_id: 'tenant-admin-ui' }),
    },
  );
  revalidatePath('/byok');
}

export default async function ByokPage(): Promise<JSX.Element> {
  const binding = await fetchBinding();
  return (
    <div>
      <PageHeader
        title="BYOK / CMEK"
        description={
          <>
            Bring-your-own-key (P8 Variant A). Your CMK wraps the Tenant Key.
            Revoking the grant on your CMK renders this tenant&apos;s data undecryptable
            within {binding?.sla_revoke_propagation_seconds ?? 30}s — this is intentional and
            cannot be undone without re-binding.
          </>
        }
      />

      {!TENANT_ID && (
        <Alert variant="warning">
          Set <code>TENANT_ADMIN_TENANT_ID</code> in this app&apos;s env to view your binding.
        </Alert>
      )}

      {binding && (
        <Card className="p-5">
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
              <input type="hidden" name="previous_tenant_key_id" value={binding.tenant_key_id} />
              <p className="mb-2 text-sm text-muted-foreground">
                <strong className="text-foreground">Rotate the tenant key.</strong> Routine
                maintenance — the new key is wrapped by the same customer CMK, so data stays
                readable throughout and the previous key is superseded, not destroyed.
              </p>
              <div className="flex gap-2">
                <Input
                  name="new_tenant_key_id"
                  placeholder="new tenant key id"
                  required
                  className="flex-1"
                />
                <Button type="submit">Rotate CMK</Button>
              </div>
            </form>
          )}

          {binding.grant_status === 'active' && (
            <form action={revokeAction} className="mt-4 rounded-md border border-destructive/40 bg-destructive/5 p-3">
              <input type="hidden" name="binding_id" value={binding.binding_id} />
              <p className="mb-2 text-destructive">
                <strong>Danger zone.</strong> Revoking will render all tenant data undecryptable. Confirm by typing a reason:
              </p>
              <div className="flex gap-2">
                <Input name="reason" placeholder="reason (required)" required minLength={6} className="flex-1" />
                <Button type="submit" variant="danger">Revoke CMK binding</Button>
              </div>
            </form>
          )}
        </Card>
      )}

      {!binding && TENANT_ID && (
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
            <Field label="Tenant Key ID (existing platform key to wrap)" htmlFor="tenant_key_id">
              <Input id="tenant_key_id" name="tenant_key_id" required />
            </Field>
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
