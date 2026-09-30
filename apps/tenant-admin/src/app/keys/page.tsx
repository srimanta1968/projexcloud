import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { gateway, GatewayError } from '../../lib/gateway';
import { Alert, Button, Card, Input, PageHeader } from '@projexlight/design-system';

/**
 * Tenant-scoped key lifecycle: person, device and encounter keys.
 *
 * WHY SHRED IS THE POINT OF THIS SCREEN.
 *
 * Crypto-shredding is how an erasure request is actually honoured. The rows stay — you
 * cannot rewrite an append-only ledger or an audit chain to satisfy a deletion — but the
 * key that decrypts that subject's data is destroyed, so the data becomes permanently
 * unreadable. Until now that capability existed only as an API call with no operator
 * path, which meant the product could satisfy a DSAR in principle and not in practice.
 *
 * WHY THERE IS NO CUSTOMER-KEY BINDING HERE. A customer-managed key attaches at the
 * TENANT boundary, on the BYOK screen. A person has no KMS account, and a per-person CMK
 * would make every read of that person's data depend on one individual's external key.
 * These tiers get lifecycle, not ownership.
 *
 * The list is scoped to the calling tenant IN SQL by the gateway — this screen cannot
 * widen it, and a key belonging to another tenant answers 404 rather than 403 so that
 * probing an id cannot confirm it exists elsewhere.
 */

interface KeyRow {
  key_id: string;
  tier: 'root' | 'app' | 'pool' | 'tenant' | 'person' | 'device' | 'encounter';
  scope_id: string | null;
  parent_key_id: string | null;
  kms_ref: string | null;
  state: 'issued' | 'active' | 'rotated' | 'shredded';
  algorithm: string;
  issued_at: string;
  rotated_at: string | null;
  shredded_at: string | null;
  tenant_id: string | null;
  region: string;
}

/**
 * Every call goes out with the SIGNED-IN admin's session (lib/gateway), so the gateway scopes
 * the keys to that admin's tenant. It used to use one server-wide TENANT_ADMIN_TOKEN: every
 * admin of every tenant then saw — and could rotate or SHRED — the keys of whichever tenant
 * that env token belonged to.
 */

/** null = the call failed (with the gateway's reason); [] = genuinely no keys at that tier. */
async function fetchKeys(tier: string): Promise<{ rows: KeyRow[] | null; error: string | null }> {
  try {
    const rows = await gateway.get<KeyRow[]>(`/api/vault/keys?tier=${encodeURIComponent(tier)}&limit=200`);
    return { rows: Array.isArray(rows) ? rows : [], error: null };
  } catch (err) {
    return { rows: null, error: err instanceof GatewayError ? err.message : 'the gateway could not be reached' };
  }
}

async function shredKeyAction(formData: FormData): Promise<void> {
  'use server';
  const key_id = String(formData.get('key_id') ?? '');
  const reason = String(formData.get('reason') ?? '').trim();
  const confirm = String(formData.get('confirm') ?? '').trim();
  // Typing SHRED is not ceremony. This is the one control on the screen whose effect
  // cannot be undone by any later action — there is no re-issue that recovers the data,
  // because the material is gone rather than revoked.
  if (!key_id || !reason || confirm !== 'SHRED') return;
  let error = '';
  try {
    await gateway.post(`/api/vault/keys/${encodeURIComponent(key_id)}/shred`, { reason });
  } catch (err) {
    error = err instanceof GatewayError ? err.message : 'Could not shred the key';
  }
  revalidatePath('/keys');
  redirect(error ? `/keys?error=${encodeURIComponent(error)}` : '/keys?done=shredded');
}

async function rotateKeyAction(formData: FormData): Promise<void> {
  'use server';
  const key_id = String(formData.get('key_id') ?? '');
  const reason = String(formData.get('reason') ?? '').trim();
  if (!key_id || !reason) return;
  let error = '';
  try {
    await gateway.post(`/api/vault/keys/${encodeURIComponent(key_id)}/rotate`, { reason });
  } catch (err) {
    error = err instanceof GatewayError ? err.message : 'Could not rotate the key';
  }
  revalidatePath('/keys');
  redirect(error ? `/keys?error=${encodeURIComponent(error)}` : '/keys?done=rotated');
}

function StateBadge({ state }: { state: KeyRow['state'] }): JSX.Element {
  const tone =
    state === 'active' ? 'bg-emerald-500/15 text-emerald-700'
      : state === 'shredded' ? 'bg-destructive/15 text-destructive'
        : state === 'rotated' ? 'bg-amber-500/15 text-amber-700'
          : 'bg-muted text-muted-foreground';
  return <span className={`rounded px-2 py-0.5 text-xs font-medium ${tone}`}>{state}</span>;
}

function KeySection({ title, blurb, rows }: { title: string; blurb: string; rows: KeyRow[] }): JSX.Element {
  return (
    <Card className="p-5">
      <h2 className="mb-1 text-lg font-semibold">{title}</h2>
      <p className="mb-3 text-sm text-muted-foreground">{blurb}</p>
      {rows.length === 0 ? (
        <p className="text-sm text-muted-foreground">No keys at this tier.</p>
      ) : (
        <div className="grid gap-3">
          {rows.map((k) => (
            <div key={k.key_id} className="rounded-md border p-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="font-mono text-xs break-all">{k.key_id}</span>
                <StateBadge state={k.state} />
              </div>
              <dl className="mt-2 grid grid-cols-[110px_1fr] gap-x-3 gap-y-1 text-xs">
                <dt className="text-muted-foreground">Scope</dt>
                <dd className="m-0 font-mono break-all">{k.scope_id ?? '—'}</dd>
                <dt className="text-muted-foreground">Issued</dt>
                <dd className="m-0">{new Date(k.issued_at).toLocaleString()}</dd>
                {k.shredded_at && (
                  <>
                    <dt className="text-muted-foreground">Shredded</dt>
                    <dd className="m-0">{new Date(k.shredded_at).toLocaleString()}</dd>
                  </>
                )}
              </dl>

              {k.state === 'active' && (
                <div className="mt-3 grid gap-2">
                  <form action={rotateKeyAction} className="flex gap-2">
                    <input type="hidden" name="key_id" value={k.key_id} />
                    <Input name="reason" placeholder="rotation reason" required minLength={4} className="h-8 flex-1 text-xs" />
                    <Button type="submit" className="h-8 px-3 text-xs">Rotate</Button>
                  </form>

                  <form action={shredKeyAction} className="rounded-md border border-destructive/40 bg-destructive/5 p-2">
                    <input type="hidden" name="key_id" value={k.key_id} />
                    <p className="mb-2 text-xs text-destructive">
                      <strong>Crypto-erase.</strong> Destroys the key material permanently.
                      Data encrypted under it becomes unreadable and cannot be recovered —
                      this is how an erasure request is satisfied, not a soft delete.
                      Type <code>SHRED</code> to confirm.
                    </p>
                    <div className="flex flex-wrap gap-2">
                      <Input name="reason" placeholder="reason (e.g. DSAR-1042)" required minLength={4} className="h-8 flex-1 text-xs" />
                      <Input name="confirm" placeholder="SHRED" required pattern="SHRED" className="h-8 w-28 text-xs" />
                      <Button type="submit" variant="danger" className="h-8 px-3 text-xs">Shred key</Button>
                    </div>
                  </form>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}

export default async function TenantKeysPage({ searchParams }: { searchParams: { error?: string; done?: string } }): Promise<JSX.Element> {
  const [p, d, e] = await Promise.all([fetchKeys('person'), fetchKeys('device'), fetchKeys('encounter')]);
  const person = p.rows;
  const device = d.rows;
  const encounter = e.rows;
  const unreachable = person === null && device === null && encounter === null;
  const cause = p.error ?? d.error ?? e.error;

  return (
    <div>
      <PageHeader
        title="Keys"
        description={
          <>
            Per-subject key lifecycle for this tenant. Shredding a key crypto-erases the
            data encrypted under it — the records remain, and become permanently
            unreadable. Customer-managed keys are configured separately, on the BYOK
            screen.
          </>
        }
      />

      {searchParams.error ? <Alert variant="destructive">{searchParams.error}</Alert> : null}
      {searchParams.done ? <Alert variant="success">Key {searchParams.done}.</Alert> : null}

      {unreachable && (
        <Alert variant="warning">
          Could not read keys{cause ? <>: {cause}</> : null}. Either the gateway is unreachable, or no KMS provider is
          configured in this environment — <code>/api/vault/*</code> then fails rather than
          returning an empty list, so this is not the same as &quot;you have no keys&quot;.
        </Alert>
      )}

      {!unreachable && (
        <div className="grid gap-4">
          <KeySection
            title="Person"
            blurb="One key per subject. Shredding it is how an erasure request is honoured."
            rows={person ?? []}
          />
          <KeySection
            title="Device"
            blurb="Per-device keys. Shred on decommission or loss."
            rows={device ?? []}
          />
          <KeySection
            title="Encounter"
            blurb="Short-lived, per-encounter keys. Usually expire; shred to end one early."
            rows={encounter ?? []}
          />
        </div>
      )}
    </div>
  );
}
