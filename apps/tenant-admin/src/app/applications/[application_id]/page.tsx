import Link from 'next/link';
import { revalidatePath } from 'next/cache';
import {
  Alert,
  Badge,
  Button,
  Card,
  Field,
  Input,
  PageHeader,
  Select,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@projexlight/design-system';
import { StatusBadge } from '../../../components/StatusBadge';
import {
  gateway,
  GatewayError,
  graceRemaining,
  successorOf,
  type ApplicationRow,
  type KeyRow,
} from '../../../lib/gateway';
import { RevealedKey } from './RevealedKey';
import { ScopePicker } from './ScopePicker';

export const dynamic = 'force-dynamic';

interface PageProps {
  params: { application_id: string };
  searchParams: { issued?: string; rotated?: string; error?: string };
}

async function load(
  application_id: string,
): Promise<{ application?: ApplicationRow; keys: KeyRow[]; error?: string }> {
  try {
    const res = await gateway.get<{ application: ApplicationRow; keys: KeyRow[] }>(
      `/api/applications/${encodeURIComponent(application_id)}`,
    );
    return { application: res.application, keys: res.keys ?? [] };
  } catch (err) {
    return { keys: [], error: err instanceof GatewayError ? err.message : 'Could not reach the gateway' };
  }
}

/**
 * Issue, rotate and revoke all redirect back with the plaintext in the URL for
 * exactly one render.
 *
 * The previous implementation stashed it in a NON-httpOnly cookie, which any
 * script on the origin could read and which survived until it expired. A search
 * param is consumed by the redirect that follows and never written to storage;
 * the component below strips it from the address bar as soon as it has painted,
 * so it does not linger in history either.
 */

async function issueKey(formData: FormData): Promise<void> {
  'use server';
  const application_id = String(formData.get('application_id') ?? '');
  const name = String(formData.get('name') ?? '').trim();
  const scopes = formData
    .getAll('scopes')
    .map((s) => String(s).trim())
    .filter(Boolean);
  const rate_limit_rpm = Number(formData.get('rate_limit_rpm') ?? 0);
  const expires_at = String(formData.get('expires_at') ?? '').trim();

  const { redirect } = await import('next/navigation');
  if (scopes.length === 0) {
    redirect(`/applications/${application_id}?error=${encodeURIComponent('Choose at least one scope')}`);
  }

  try {
    const res = await gateway.post<{ plaintext: string }>(
      `/api/applications/${encodeURIComponent(application_id)}/keys`,
      {
        name: name || undefined,
        scopes,
        rate_limit_rpm: rate_limit_rpm > 0 ? rate_limit_rpm : undefined,
        // <input type="datetime-local"> yields local wall time with no zone;
        // sending it as-is would be read as UTC and could land in the past.
        expires_at: expires_at ? new Date(expires_at).toISOString() : undefined,
      },
    );
    revalidatePath(`/applications/${application_id}`);
    redirect(`/applications/${application_id}?issued=${encodeURIComponent(res.plaintext)}`);
  } catch (err) {
    if (err instanceof GatewayError) {
      redirect(`/applications/${application_id}?error=${encodeURIComponent(err.message)}`);
    }
    throw err;
  }
}

async function rotateKey(formData: FormData): Promise<void> {
  'use server';
  const application_id = String(formData.get('application_id') ?? '');
  const key_id = String(formData.get('key_id') ?? '');
  const { redirect } = await import('next/navigation');
  try {
    const res = await gateway.post<{ plaintext: string }>(
      `/api/api-keys/${encodeURIComponent(key_id)}/rotate`,
    );
    revalidatePath(`/applications/${application_id}`);
    redirect(`/applications/${application_id}?rotated=${encodeURIComponent(res.plaintext)}`);
  } catch (err) {
    if (err instanceof GatewayError) {
      redirect(`/applications/${application_id}?error=${encodeURIComponent(err.message)}`);
    }
    throw err;
  }
}

async function revokeKey(formData: FormData): Promise<void> {
  'use server';
  const application_id = String(formData.get('application_id') ?? '');
  const key_id = String(formData.get('key_id') ?? '');
  const reason = String(formData.get('reason') ?? '').trim();
  const { redirect } = await import('next/navigation');
  if (reason.length < 4) {
    redirect(
      `/applications/${application_id}?error=${encodeURIComponent('Give a reason so the audit trail explains why this key stopped working')}`,
    );
  }
  try {
    await gateway.post(`/api/api-keys/${encodeURIComponent(key_id)}/revoke`, { reason });
    revalidatePath(`/applications/${application_id}`);
  } catch (err) {
    if (err instanceof GatewayError) {
      redirect(`/applications/${application_id}?error=${encodeURIComponent(err.message)}`);
    }
    throw err;
  }
}

async function disableApplication(formData: FormData): Promise<void> {
  'use server';
  const application_id = String(formData.get('application_id') ?? '');
  await gateway.post(`/api/applications/${encodeURIComponent(application_id)}/disable`);
  revalidatePath(`/applications/${application_id}`);
}

export default async function ApplicationDetailPage({
  params,
  searchParams,
}: PageProps): Promise<JSX.Element> {
  const { application, keys, error } = await load(params.application_id);
  const successors = successorOf(keys);
  const revealed = searchParams.issued || searchParams.rotated;

  if (!application) {
    return (
      <div>
        <PageHeader title="Application" description="" />
        <Alert variant="destructive">{error ?? 'No such application.'}</Alert>
        <Link className="mt-4 inline-block underline" href="/applications">
          Back to applications
        </Link>
      </div>
    );
  }

  const live = keys.filter((k) => k.status !== 'revoked');

  return (
    <div>
      <PageHeader
        title={application.name}
        description={`Client ID ${application.slug} · ${application.environment} environment`}
      />

      {error && (
        <Alert variant="destructive" className="mb-4">
          {error}
        </Alert>
      )}
      {searchParams.error && (
        <Alert variant="destructive" className="mb-4">
          {searchParams.error}
        </Alert>
      )}

      {revealed && (
        <RevealedKey
          plaintext={revealed}
          rotated={Boolean(searchParams.rotated)}
          graceHours={24}
        />
      )}

      {application.status === 'active' ? (
        <Card className="mb-6 max-w-2xl p-5">
          <h2 className="mb-1 text-lg font-semibold">Issue a key</h2>
          <p className="mb-4 text-sm text-muted-foreground">
            Grant only what this application calls. A key with narrower scopes is a smaller problem
            if it leaks, and a missing scope tells you exactly which one it needs.
          </p>
          <form action={issueKey} className="grid gap-3.5">
            <input type="hidden" name="application_id" value={application.application_id} />
            <Field label="Name" htmlFor="name" hint="What uses this key. Shown in the list below.">
              <Input id="name" name="name" placeholder="Nightly sync job" />
            </Field>

            <ScopePicker />

            <div className="grid gap-3.5 sm:grid-cols-2">
              <Field
                label="Rate limit (requests per minute)"
                htmlFor="rate_limit_rpm"
                hint="Leave blank for no limit."
              >
                <Input id="rate_limit_rpm" name="rate_limit_rpm" type="number" min="1" placeholder="600" />
              </Field>
              <Field
                label="Expires"
                htmlFor="expires_at"
                hint="A key that never expires is a standing liability."
              >
                <Input id="expires_at" name="expires_at" type="datetime-local" />
              </Field>
            </div>

            <Button type="submit" className="justify-self-start">
              Issue key
            </Button>
          </form>
        </Card>
      ) : (
        <Alert className="mb-6">
          This application is disabled and its keys were revoked. Create a new application to issue
          credentials again.
        </Alert>
      )}

      <div className="mb-6 rounded-lg border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Key</TableHead>
              <TableHead>Name</TableHead>
              <TableHead>Scopes</TableHead>
              <TableHead>Limit</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Last used</TableHead>
              <TableHead></TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {keys.length === 0 && (
              <TableRow>
                <TableCell colSpan={7} className="text-muted-foreground">
                  No keys yet.
                </TableCell>
              </TableRow>
            )}
            {keys.map((k) => {
              const grace = graceRemaining(k, successors.get(k.key_id));
              const unused = k.status === 'active' && !k.last_used_at;
              return (
                <TableRow key={k.key_id}>
                  <TableCell className="font-mono text-[11px]">{k.prefix}</TableCell>
                  <TableCell>{k.name ?? '—'}</TableCell>
                  <TableCell className="max-w-[18rem] text-xs">
                    {k.scopes.join(', ') || '—'}
                  </TableCell>
                  <TableCell className="text-xs">
                    {k.rate_limit_rpm ? `${k.rate_limit_rpm}/min` : 'none'}
                  </TableCell>
                  <TableCell>
                    <StatusBadge status={k.status} />
                    {grace && <div className="mt-1 text-[11px] text-amber-700">{grace}</div>}
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground">
                    {k.last_used_at ? (
                      new Date(k.last_used_at).toLocaleString()
                    ) : (
                      <span title="Nothing has authenticated with this key. If that is unexpected, it is safe to revoke.">
                        never
                      </span>
                    )}
                    {unused && (
                      <div className="text-[11px] text-muted-foreground">
                        unused — safe to revoke
                      </div>
                    )}
                  </TableCell>
                  <TableCell>
                    {k.status !== 'revoked' && (
                      <div className="flex flex-col gap-2">
                        <form action={rotateKey}>
                          <input type="hidden" name="application_id" value={application.application_id} />
                          <input type="hidden" name="key_id" value={k.key_id} />
                          <Button type="submit" size="sm" variant="ghost">
                            Rotate
                          </Button>
                        </form>
                        <form action={revokeKey} className="flex items-center gap-2">
                          <input type="hidden" name="application_id" value={application.application_id} />
                          <input type="hidden" name="key_id" value={k.key_id} />
                          <Input name="reason" placeholder="reason" required minLength={4} className="h-8 w-32" />
                          <Button
                            type="submit"
                            size="sm"
                            variant="ghost"
                            className="text-destructive hover:text-destructive"
                          >
                            Revoke
                          </Button>
                        </form>
                      </div>
                    )}
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </div>

      {application.status === 'active' && (
        <Card className="max-w-2xl border-destructive/40 p-5">
          <h2 className="mb-1 text-lg font-semibold">Disable this application</h2>
          <p className="mb-4 text-sm text-muted-foreground">
            Revokes {live.length} key{live.length === 1 ? '' : 's'} immediately and stops this
            application issuing more. Anything still calling with those credentials will start
            failing at once — this is the switch to reach for when a key has leaked.
          </p>
          <form action={disableApplication}>
            <input type="hidden" name="application_id" value={application.application_id} />
            <Button type="submit" variant="danger">
              Disable and revoke {live.length} key{live.length === 1 ? '' : 's'}
            </Button>
          </form>
        </Card>
      )}

      <Link className="mt-6 inline-block text-sm underline" href="/applications">
        Back to applications
      </Link>
    </div>
  );
}
