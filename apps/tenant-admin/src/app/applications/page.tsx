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
import { StatusBadge } from '../../components/StatusBadge';
import { gateway, GatewayError, type ApplicationRow, type KeyRow } from '../../lib/gateway';

/**
 * Applications — the thing an API key belongs to.
 *
 * A tenant runs several things against the platform, and one shared credential
 * for all of them means a leak forces every integration to rotate at once and
 * no call can be attributed to the app that made it. One application per
 * integration per environment is the shape every mature platform settled on.
 */

export const dynamic = 'force-dynamic';

async function load(): Promise<{ applications: ApplicationRow[]; keys: KeyRow[]; error?: string }> {
  try {
    const [appsRes, keysRes] = await Promise.all([
      gateway.get<{ applications: ApplicationRow[] }>('/api/applications'),
      gateway.get<{ keys: KeyRow[] }>('/api/api-keys'),
    ]);
    return { applications: appsRes.applications ?? [], keys: keysRes.keys ?? [] };
  } catch (err) {
    // Surfaced, not swallowed. Returning [] here would render an empty table,
    // which reads as "you have no applications" rather than "this call failed".
    return {
      applications: [],
      keys: [],
      error: err instanceof GatewayError ? err.message : 'Could not reach the gateway',
    };
  }
}

async function createApplication(formData: FormData): Promise<void> {
  'use server';
  const name = String(formData.get('name') ?? '').trim();
  const environment = String(formData.get('environment') ?? 'live');
  const description = String(formData.get('description') ?? '').trim();
  if (!name) return;
  await gateway.post('/api/applications', { name, environment, description: description || undefined });
  revalidatePath('/applications');
}

export default async function ApplicationsPage(): Promise<JSX.Element> {
  const { applications, keys, error } = await load();
  const keyCount = new Map<string, number>();
  const lastUsed = new Map<string, string>();
  for (const k of keys) {
    if (!k.application_id) continue;
    if (k.status !== 'revoked') keyCount.set(k.application_id, (keyCount.get(k.application_id) ?? 0) + 1);
    if (k.last_used_at) {
      const current = lastUsed.get(k.application_id);
      if (!current || k.last_used_at > current) lastUsed.set(k.application_id, k.last_used_at);
    }
  }

  return (
    <div>
      <PageHeader
        title="Applications"
        description="Each app, job or environment that calls ProjexCloud gets its own application and its own keys, so one leak never forces the rest to rotate."
      />

      {error && (
        <Alert variant="destructive" className="mb-4">
          {error}
        </Alert>
      )}

      <Card className="mb-6 max-w-xl p-5">
        <h2 className="mb-4 text-lg font-semibold">New application</h2>
        <form action={createApplication} className="grid gap-3.5">
          <Field label="Name" htmlFor="name">
            <Input id="name" name="name" required placeholder="Web backend" />
          </Field>
          <Field
            label="Environment"
            htmlFor="environment"
            hint="A test application mints pk_test_ keys. Keep development on its own application so a leaked dev key can never touch live data."
          >
            <Select id="environment" name="environment" defaultValue="live">
              <option value="live">Live</option>
              <option value="test">Test</option>
            </Select>
          </Field>
          <Field label="Description" htmlFor="description">
            <Input id="description" name="description" placeholder="What calls the platform from here" />
          </Field>
          <Button type="submit" className="justify-self-start">
            Create
          </Button>
        </form>
      </Card>

      <div className="rounded-lg border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead>Client ID</TableHead>
              <TableHead>Environment</TableHead>
              <TableHead>Active keys</TableHead>
              <TableHead>Last used</TableHead>
              <TableHead>Status</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {applications.length === 0 && !error && (
              <TableRow>
                <TableCell colSpan={6} className="text-muted-foreground">
                  No applications yet. Create one for each thing that calls the platform — your backend,
                  a scheduled job, your staging copy — so each can be revoked or rotated on its own.
                </TableCell>
              </TableRow>
            )}
            {applications.map((app) => (
              <TableRow key={app.application_id}>
                <TableCell>
                  <Link className="font-medium underline-offset-2 hover:underline" href={`/applications/${app.application_id}`}>
                    {app.name}
                  </Link>
                  {app.description && (
                    <div className="text-xs text-muted-foreground">{app.description}</div>
                  )}
                </TableCell>
                <TableCell className="font-mono text-xs">{app.slug}</TableCell>
                <TableCell>
                  <Badge variant={app.environment === 'live' ? 'default' : 'secondary'}>
                    {app.environment}
                  </Badge>
                </TableCell>
                <TableCell>{keyCount.get(app.application_id) ?? 0}</TableCell>
                <TableCell className="text-xs text-muted-foreground">
                  {lastUsed.get(app.application_id)
                    ? new Date(lastUsed.get(app.application_id) as string).toLocaleString()
                    : 'never'}
                </TableCell>
                <TableCell>
                  <StatusBadge status={app.status} />
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
