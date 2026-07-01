import {
  Button,
  PageHeader,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@projexlight/design-system';
import { requirePlatformOperator } from '../../../lib/session';
import { revokeOpsTokenAction } from './actions';
import { MintTokenForm } from './MintTokenForm';

interface OpsTokenRow {
  id: string;
  label: string;
  status: 'active' | 'revoked';
  created_by: string | null;
  reason: string | null;
  created_at: string;
  expires_at: string | null;
  last_used_at: string | null;
  revoked_at: string | null;
}

async function fetchTokens(): Promise<OpsTokenRow[]> {
  try {
    const res = await fetch(`${process.env.NEXT_PUBLIC_GATEWAY_URL}/admin/security/ops-tokens`, {
      cache: 'no-store',
      headers: { 'x-admin-ops-token': process.env.ADMIN_OPS_TOKEN ?? '' },
    });
    if (!res.ok) return [];
    return (await res.json()).data ?? [];
  } catch {
    return [];
  }
}

function isExpired(row: OpsTokenRow): boolean {
  return !!row.expires_at && new Date(row.expires_at).getTime() <= Date.now();
}

export default async function OpsTokensPage(): Promise<JSX.Element> {
  // Defense-in-depth: middleware already gates /security to platform operators,
  // but re-assert here so a direct render (or a future matcher change) can't leak.
  await requirePlatformOperator();
  const tokens = await fetchTokens();

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Admin ops tokens"
        description={
          <>
            Grant and revoke <code>x-admin-ops-token</code> credentials for the platform{' '}
            <code>/admin/*</code> API — e.g. a short-lived, revocable token for QA — without
            rotating the shared secret or redeploying the gateway. Platform-operator only.
          </>
        }
      />

      <MintTokenForm />

      <div className="rounded-lg border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Label</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Expires</TableHead>
              <TableHead>Created by</TableHead>
              <TableHead>Created</TableHead>
              <TableHead>Last used</TableHead>
              <TableHead className="text-right">Action</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {tokens.length === 0 && (
              <TableRow>
                <TableCell colSpan={7} className="text-muted-foreground">
                  No tokens issued yet.
                </TableCell>
              </TableRow>
            )}
            {tokens.map((t) => {
              const expired = isExpired(t);
              const live = t.status === 'active' && !expired;
              return (
                <TableRow key={t.id}>
                  <TableCell className="font-medium">
                    {t.label}
                    {t.reason && (
                      <span className="block text-xs text-muted-foreground">{t.reason}</span>
                    )}
                  </TableCell>
                  <TableCell>
                    <span
                      className={
                        live
                          ? 'text-green-700'
                          : t.status === 'revoked'
                            ? 'text-destructive'
                            : 'text-muted-foreground'
                      }
                    >
                      {t.status === 'revoked' ? 'revoked' : expired ? 'expired' : 'active'}
                    </span>
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground">
                    {t.expires_at ? new Date(t.expires_at).toLocaleString() : 'never'}
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground">{t.created_by ?? '—'}</TableCell>
                  <TableCell className="text-xs text-muted-foreground">
                    {new Date(t.created_at).toLocaleString()}
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground">
                    {t.last_used_at ? new Date(t.last_used_at).toLocaleString() : '—'}
                  </TableCell>
                  <TableCell className="text-right">
                    {live ? (
                      <form action={revokeOpsTokenAction}>
                        <input type="hidden" name="id" value={t.id} />
                        <Button type="submit" variant="secondary" size="sm">
                          Revoke
                        </Button>
                      </form>
                    ) : (
                      <span className="text-xs text-muted-foreground">—</span>
                    )}
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
