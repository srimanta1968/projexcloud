import { revalidatePath } from 'next/cache';
import { gateway } from '../../lib/gateway';
import {
  Alert,
  Button,
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

interface RouteRow {
  route_id: string;
  name: string;
  sla_minutes: number;
  created_at: string;
}

interface RequestRow {
  request_id: string;
  route_id: string;
  subject_ref: string;
  status: string;
  /** The gateway returns requested_at for requests. */
  requested_at: string;
}

/*
 * Every call goes through the authenticated gateway helper: the tenant and the approver are
 * the signed-in admin's own (the gateway pins both). These calls used to be bare fetches with
 * no Authorization header and a tenant / persona from env vars — every one 401'd against the
 * default-deny gate, so the page showed nothing and nobody could decide a request here.
 */

async function myPersona(): Promise<string | null> {
  try {
    const me = await gateway.get<{ primary_persona_id?: string | null; sub?: string }>('/api/userinfo');
    return me.primary_persona_id ?? me.sub ?? null;
  } catch { return null; }
}

async function fetchRoutes(): Promise<RouteRow[]> {
  try { return await gateway.get<RouteRow[]>('/api/approvals/routes'); } catch { return []; }
}

async function fetchMyPending(persona: string | null): Promise<RequestRow[]> {
  if (!persona) return [];
  try {
    return await gateway.get<RequestRow[]>(`/api/approvals/requests?assignee_persona_id=${encodeURIComponent(persona)}`);
  } catch { return []; }
}

async function decideAction(formData: FormData): Promise<void> {
  'use server';
  const request_id = String(formData.get('request_id') ?? '');
  // The gateway decides the caller's own pending step on the request (403 when there is none).
  await gateway.post(`/api/approvals/requests/${encodeURIComponent(request_id)}/decide`, {
    decision: String(formData.get('decision') ?? 'rejected'),
    comment: String(formData.get('comment') ?? ''),
  }).catch(() => undefined);
  revalidatePath('/approvals');
}

export default async function ApprovalsPage(): Promise<JSX.Element> {
  const persona = await myPersona();
  const [routes, pending] = await Promise.all([fetchRoutes(), fetchMyPending(persona)]);
  const SELF_PERSONA = persona;
  return (
    <div>
      <PageHeader title="Approvals" description="Decisions assigned to you and the approval routes configured for this tenant." />

      <h2 className="mb-3 text-lg font-semibold">My pending decisions</h2>
      {!SELF_PERSONA && (
        <Alert variant="warning" className="mb-3">
          Your session has no persona, so no decisions can be assigned to you.
        </Alert>
      )}
      <div className="mb-6 rounded-lg border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Request</TableHead>
              <TableHead>Subject</TableHead>
              <TableHead>Created</TableHead>
              <TableHead>Decide</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {pending.length === 0 && (
              <TableRow><TableCell colSpan={4} className="text-muted-foreground">No pending decisions.</TableCell></TableRow>
            )}
            {pending.map((r) => (
              <TableRow key={r.request_id}>
                <TableCell className="font-mono text-[11px]">{r.request_id}</TableCell>
                <TableCell className="font-mono text-xs">{r.subject_ref}</TableCell>
                <TableCell className="text-xs text-muted-foreground">{new Date(r.requested_at).toLocaleString()}</TableCell>
                <TableCell>
                  <form action={decideAction} className="flex items-center gap-2">
                    <input type="hidden" name="request_id" value={r.request_id} />
                    <Select name="decision" className="h-8 w-28">
                      <option value="approved">approve</option>
                      <option value="rejected">reject</option>
                    </Select>
                    <Input name="comment" placeholder="comment" required minLength={4} className="h-8 w-60" />
                    <Button type="submit" size="sm">Decide</Button>
                  </form>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>

      <h2 className="mb-3 text-lg font-semibold">Routes</h2>
      <div className="rounded-lg border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Route</TableHead>
              <TableHead>Name</TableHead>
              <TableHead className="text-right">SLA (min)</TableHead>
              <TableHead>Created</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {routes.length === 0 && (
              <TableRow><TableCell colSpan={4} className="text-muted-foreground">No routes.</TableCell></TableRow>
            )}
            {routes.map((r) => (
              <TableRow key={r.route_id}>
                <TableCell className="font-mono text-[11px]">{r.route_id}</TableCell>
                <TableCell>{r.name}</TableCell>
                <TableCell className="text-right tabular-nums">{r.sla_minutes}</TableCell>
                <TableCell className="text-xs text-muted-foreground">{new Date(r.created_at).toLocaleString()}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
