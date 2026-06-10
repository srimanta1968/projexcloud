import { revalidatePath } from 'next/cache';
import Link from 'next/link';
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

interface DlqRow {
  delivery_id: string;
  endpoint_id: string;
  event_type: string;
  last_status_code: number | null;
  last_error: string | null;
  attempts: number;
  failed_at: string;
}

async function fetchDlq(): Promise<DlqRow[]> {
  try {
    const res = await fetch(`${process.env.NEXT_PUBLIC_GATEWAY_URL}/admin/webhooks/dlq`, {
      cache: 'no-store',
      headers: { 'x-admin-ops-token': process.env.ADMIN_OPS_TOKEN ?? '' },
    });
    if (!res.ok) return [];
    return (await res.json()).data ?? [];
  } catch { return []; }
}

async function replayAction(formData: FormData): Promise<void> {
  'use server';
  const delivery_id = String(formData.get('delivery_id') ?? '');
  await fetch(
    `${process.env.NEXT_PUBLIC_GATEWAY_URL}/admin/webhooks/dlq/${encodeURIComponent(delivery_id)}/replay`,
    {
      method: 'POST',
      headers: { 'x-admin-ops-token': process.env.ADMIN_OPS_TOKEN ?? '' },
    },
  );
  revalidatePath('/webhooks/dlq');
}

export default async function DlqPage(): Promise<JSX.Element> {
  const rows = await fetchDlq();
  return (
    <div>
      <Link href="/webhooks" className="text-sm text-primary hover:underline">← Endpoints</Link>
      <PageHeader
        className="mt-2"
        title="Webhook DLQ"
        description="Failed deliveries. Replay restores them within the configured window."
      />
      <div className="rounded-lg border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Delivery</TableHead>
              <TableHead>Event type</TableHead>
              <TableHead>Last status</TableHead>
              <TableHead className="text-right">Attempts</TableHead>
              <TableHead>Failed at</TableHead>
              <TableHead></TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.length === 0 && (
              <TableRow><TableCell colSpan={6} className="text-muted-foreground">DLQ empty.</TableCell></TableRow>
            )}
            {rows.map((r) => (
              <TableRow key={r.delivery_id}>
                <TableCell className="font-mono text-xs">{r.delivery_id}</TableCell>
                <TableCell className="font-mono text-xs">{r.event_type}</TableCell>
                <TableCell>{r.last_status_code ?? '—'}</TableCell>
                <TableCell className="text-right tabular-nums">{r.attempts}</TableCell>
                <TableCell className="text-xs text-muted-foreground">{new Date(r.failed_at).toLocaleString()}</TableCell>
                <TableCell>
                  <form action={replayAction}>
                    <input type="hidden" name="delivery_id" value={r.delivery_id} />
                    <Button type="submit" size="sm" variant="secondary">Replay</Button>
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
