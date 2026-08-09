import { revalidatePath } from 'next/cache';
import { Alert, Button, Card, Input, PageHeader } from '@projexlight/design-system';

/**
 * Operator view of the vault key hierarchy.
 *
 * WHY THIS SCREEN HAS NO "BIND CUSTOMER KEY" FORM, and must never grow one.
 *
 * A key at tier N is wrapped by its parent, so whoever holds the key at tier N controls
 * everything beneath it. root/app/pool wrap EVERY tenant — binding an external
 * customer-managed key here would hand one party the wrapping key for all of them.
 * Customer-managed keys attach at the TENANT boundary and nowhere above it, which is
 * what the tenant-admin BYOK screen is for.
 *
 * What an operator needs here instead is lifecycle: see the hierarchy, rotate on
 * schedule, and know which keys are shredded. Rotation is routine; the destructive
 * operation (shred) is deliberately absent at these tiers, because shredding a root key
 * makes every tenant beneath it undecryptable and is not a console button.
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
const OPS_TOKEN = process.env.ADMIN_OPS_TOKEN ?? '';

/** null means the call itself failed — distinct from "no keys", which is []. */
async function fetchKeys(tier: string): Promise<KeyRow[] | null> {
  try {
    const res = await fetch(`${GATEWAY}/admin/vault/keys?tier=${encodeURIComponent(tier)}&limit=200`, {
      cache: 'no-store',
      headers: { 'x-admin-ops-token': OPS_TOKEN },
    });
    if (!res.ok) return null;
    const body = await res.json();
    return (body.data ?? []) as KeyRow[];
  } catch {
    return null;
  }
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
      'x-admin-ops-token': OPS_TOKEN,
    },
    body: JSON.stringify({ reason }),
  });
  revalidatePath('/security/vault-keys');
}

function StateBadge({ state }: { state: KeyRow['state'] }): JSX.Element {
  const tone =
    state === 'active' ? 'bg-emerald-500/15 text-emerald-700'
      : state === 'shredded' ? 'bg-destructive/15 text-destructive'
        : state === 'rotated' ? 'bg-amber-500/15 text-amber-700'
          : 'bg-muted text-muted-foreground';
  return <span className={`rounded px-2 py-0.5 text-xs font-medium ${tone}`}>{state}</span>;
}

function KeyTable({ rows }: { rows: KeyRow[] }): JSX.Element {
  if (rows.length === 0) {
    return <p className="text-sm text-muted-foreground">No keys at this tier.</p>;
  }
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b text-left text-xs uppercase tracking-wide text-muted-foreground">
            <th className="py-2 pr-3">Key</th>
            <th className="py-2 pr-3">State</th>
            <th className="py-2 pr-3">KMS ref</th>
            <th className="py-2 pr-3">Region</th>
            <th className="py-2 pr-3">Issued</th>
            <th className="py-2">Rotate</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((k) => (
            <tr key={k.key_id} className="border-b last:border-0 align-top">
              <td className="py-2 pr-3 font-mono text-xs">{k.key_id}</td>
              <td className="py-2 pr-3"><StateBadge state={k.state} /></td>
              <td className="py-2 pr-3 font-mono text-xs break-all">{k.kms_ref ?? <em className="text-muted-foreground">cleared</em>}</td>
              <td className="py-2 pr-3">{k.region}</td>
              <td className="py-2 pr-3 whitespace-nowrap">{new Date(k.issued_at).toLocaleDateString()}</td>
              <td className="py-2">
                {/* Only an ACTIVE key can be rotated. A rotated key has already been
                    superseded and a shredded one no longer has material to re-wrap, so
                    offering the control there would produce a guaranteed error. */}
                {k.state === 'active' ? (
                  <form action={rotateKeyAction} className="flex gap-2">
                    <input type="hidden" name="key_id" value={k.key_id} />
                    <Input name="reason" placeholder="reason" required minLength={4} className="h-8 w-40 text-xs" />
                    <Button type="submit" className="h-8 px-3 text-xs">Rotate</Button>
                  </form>
                ) : (
                  <span className="text-xs text-muted-foreground">—</span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default async function VaultKeysPage(): Promise<JSX.Element> {
  const [root, app, pool] = await Promise.all([
    fetchKeys('root'),
    fetchKeys('app'),
    fetchKeys('pool'),
  ]);
  // A failed CALL and an empty RESULT mean opposite things, and conflating them is how a
  // broken gateway reads as "no keys exist" — the most reassuring possible rendering of
  // an outage. Say which one happened.
  const unreachable = root === null && app === null && pool === null;

  return (
    <div>
      <PageHeader
        title="Vault keys"
        description={
          <>
            Platform-owned tiers. These keys wrap every tenant beneath them, so they are
            managed here and never bound to a customer key — customer-managed keys attach
            at the tenant boundary, on each tenant&apos;s own BYOK screen.
          </>
        }
      />

      {unreachable && (
        <Alert variant="warning">
          Could not read the key hierarchy. The gateway may be unreachable, or no KMS
          provider is configured in this environment — <code>/api/vault/*</code> then fails
          rather than returning an empty list. Check <code>ALLOW_SYNTHETIC_*</code> is not
          being relied on and that a real provider is wired.
        </Alert>
      )}

      {!unreachable && (
        <div className="grid gap-4">
          <Card className="p-5">
            <h2 className="mb-1 text-lg font-semibold">Root</h2>
            <p className="mb-3 text-sm text-muted-foreground">
              The top of the hierarchy. Every other key descends from one of these.
            </p>
            <KeyTable rows={root ?? []} />
          </Card>

          <Card className="p-5">
            <h2 className="mb-1 text-lg font-semibold">App</h2>
            <p className="mb-3 text-sm text-muted-foreground">
              Per-application keys, wrapped by root.
            </p>
            <KeyTable rows={app ?? []} />
          </Card>

          <Card className="p-5">
            <h2 className="mb-1 text-lg font-semibold">Pool</h2>
            <p className="mb-3 text-sm text-muted-foreground">
              Infrastructure sharding tier. No external owner, so no binding — rotation only.
            </p>
            <KeyTable rows={pool ?? []} />
          </Card>
        </div>
      )}
    </div>
  );
}
