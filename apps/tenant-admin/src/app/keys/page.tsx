import { revalidatePath } from 'next/cache';
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

const GATEWAY = process.env.NEXT_PUBLIC_GATEWAY_URL ?? '';
const TENANT_TOKEN = process.env.TENANT_ADMIN_TOKEN ?? '';

/** null = the call failed; [] = the tenant genuinely has no keys at that tier. */
async function fetchKeys(tier: string): Promise<KeyRow[] | null> {
  if (!TENANT_TOKEN) return null;
  try {
    const res = await fetch(`${GATEWAY}/api/vault/keys?tier=${encodeURIComponent(tier)}&limit=200`, {
      cache: 'no-store',
      headers: { Authorization: `Bearer ${TENANT_TOKEN}` },
    });
    if (!res.ok) return null;
    const body = await res.json();
    return (body.data ?? []) as KeyRow[];
  } catch {
    return null;
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
  await fetch(`${GATEWAY}/api/vault/keys/${encodeURIComponent(key_id)}/shred`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      Authorization: `Bearer ${TENANT_TOKEN}`,
    },
    body: JSON.stringify({ reason }),
  });
  revalidatePath('/keys');
}

async function rotateKeyAction(formData: FormData): Promise<void> {
  'use server';
  const key_id = String(formData.get('key_id') ?? '');
  const reason = String(formData.get('reason') ?? '').trim();
  if (!key_id || !reason) return;
  await fetch(`${GATEWAY}/api/vault/keys/${encodeURIComponent(key_id)}/rotate`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      Authorization: `Bearer ${TENANT_TOKEN}`,
    },
    body: JSON.stringify({ reason }),
  });
  revalidatePath('/keys');
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

export default async function TenantKeysPage(): Promise<JSX.Element> {
  const [person, device, encounter] = await Promise.all([
    fetchKeys('person'),
    fetchKeys('device'),
    fetchKeys('encounter'),
  ]);
  const unreachable = person === null && device === null && encounter === null;

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

      {!TENANT_TOKEN && (
        <Alert variant="warning">
          Set <code>TENANT_ADMIN_TOKEN</code> in this app&apos;s env to read this
          tenant&apos;s keys.
        </Alert>
      )}

      {TENANT_TOKEN && unreachable && (
        <Alert variant="warning">
          Could not read keys. Either the gateway is unreachable, or no KMS provider is
          configured in this environment — <code>/api/vault/*</code> then fails rather than
          returning an empty list, so this is not the same as &quot;you have no keys&quot;.
        </Alert>
      )}

      {TENANT_TOKEN && !unreachable && (
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
