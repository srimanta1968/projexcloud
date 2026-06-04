import { revalidatePath } from 'next/cache';
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
  created_at: string;
}

const TENANT_ID = process.env.TENANT_ADMIN_TENANT_ID ?? '';
const SELF_PERSONA = process.env.TENANT_ADMIN_PERSONA_ID ?? '';

async function fetchRoutes(): Promise<RouteRow[]> {
  if (!TENANT_ID) return [];
  try {
    const res = await fetch(
      `${process.env.NEXT_PUBLIC_GATEWAY_URL}/api/approvals/routes?tenant_id=${encodeURIComponent(TENANT_ID)}`,
      { cache: 'no-store' },
    );
    if (!res.ok) return [];
    return (await res.json()).data ?? [];
  } catch { return []; }
}

async function fetchMyPending(): Promise<RequestRow[]> {
  if (!TENANT_ID || !SELF_PERSONA) return [];
  try {
    const res = await fetch(
      `${process.env.NEXT_PUBLIC_GATEWAY_URL}/api/approvals/requests?tenant_id=${encodeURIComponent(TENANT_ID)}&assignee_persona_id=${encodeURIComponent(SELF_PERSONA)}`,
      { cache: 'no-store' },
    );
    if (!res.ok) return [];
    return (await res.json()).data ?? [];
  } catch { return []; }
}

async function decideAction(formData: FormData): Promise<void> {
  'use server';
  const request_id = String(formData.get('request_id') ?? '');
  await fetch(
    `${process.env.NEXT_PUBLIC_GATEWAY_URL}/api/approvals/requests/${encodeURIComponent(request_id)}/decide`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        decision: String(formData.get('decision') ?? 'rejected'),
        comment: String(formData.get('comment') ?? ''),
        decider_persona_id: SELF_PERSONA,
      }),
    },
  );
  revalidatePath('/approvals');
}

export default async function ApprovalsPage(): Promise<JSX.Element> {
  const [routes, pending] = await Promise.all([fetchRoutes(), fetchMyPending()]);
  return (
    <div>
      <PageHeader title="Approvals" description="Decisions assigned to you and the approval routes configured for this tenant." />

      <h2 className="mb-3 text-lg font-semibold">My pending decisions</h2>
      {!SELF_PERSONA && (
        <Alert variant="warning" className="mb-3">
          Set <code>TENANT_ADMIN_PERSONA_ID</code> to see decisions assigned to you.
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
                <TableCell className="text-xs text-muted-foreground">{new Date(r.created_at).toLocaleString()}</TableCell>
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
