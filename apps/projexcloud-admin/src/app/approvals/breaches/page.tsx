import { revalidatePath } from 'next/cache';
import Link from 'next/link';
import {
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

interface BreachRow {
  request_id: string;
  tenant_id: string;
  route_id: string;
  subject_ref: string;
  created_at: string;
  status: string;
  elapsed_minutes: number;
  sla_minutes: number;
}

async function fetchBreaches(): Promise<BreachRow[]> {
  try {
    const res = await fetch(`${process.env.NEXT_PUBLIC_GATEWAY_URL}/admin/approvals/breaches`, {
      cache: 'no-store',
      headers: { 'x-admin-ops-token': process.env.ADMIN_OPS_TOKEN ?? '' },
    });
    if (!res.ok) return [];
    return (await res.json()).data ?? [];
  } catch { return []; }
}

async function overrideAction(formData: FormData): Promise<void> {
  'use server';
  const request_id = String(formData.get('request_id') ?? '');
  await fetch(
    `${process.env.NEXT_PUBLIC_GATEWAY_URL}/admin/approvals/requests/${encodeURIComponent(request_id)}/operator-override`,
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-admin-ops-token': process.env.ADMIN_OPS_TOKEN ?? '',
      },
      body: JSON.stringify({
        decision: String(formData.get('decision') ?? 'rejected'),
        reason: String(formData.get('reason') ?? ''),
        operator_id: 'admin-ui',
      }),
    },
  );
  revalidatePath('/approvals/breaches');
}

export default async function BreachesPage(): Promise<JSX.Element> {
  const rows = await fetchBreaches();
  return (
    <div>
      <Link href="/approvals" className="text-sm text-primary hover:underline">← Routes</Link>
      <PageHeader
        className="mt-2"
        title="SLA breaches"
        description="Pending requests past their SLA. Operator override requires a written reason."
      />
      <div className="rounded-lg border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Request</TableHead>
              <TableHead>Subject</TableHead>
              <TableHead className="text-right">Elapsed (min)</TableHead>
              <TableHead className="text-right">SLA</TableHead>
              <TableHead>Override</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.length === 0 && (
              <TableRow><TableCell colSpan={5} className="text-muted-foreground">No SLA breaches. 🎉</TableCell></TableRow>
            )}
            {rows.map((r) => (
              <TableRow key={r.request_id}>
                <TableCell className="font-mono text-xs">{r.request_id}</TableCell>
                <TableCell className="font-mono text-xs">{r.subject_ref}</TableCell>
                <TableCell className="text-right font-semibold tabular-nums text-destructive">{Math.round(r.elapsed_minutes)}</TableCell>
                <TableCell className="text-right tabular-nums">{r.sla_minutes}</TableCell>
                <TableCell>
                  <form action={overrideAction} className="flex items-center gap-2">
                    <input type="hidden" name="request_id" value={r.request_id} />
                    <Select name="decision" className="h-8 w-28">
                      <option value="approved">approve</option>
                      <option value="rejected">reject</option>
                    </Select>
                    <Input name="reason" placeholder="reason" required minLength={4} className="h-8 w-52" />
                    <Button type="submit" size="sm">Override</Button>
                  </form>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
