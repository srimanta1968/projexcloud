import { revalidatePath } from 'next/cache';
import {
  Button,
  Input,
  PageHeader,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@projexlight/design-system';
import { StatusBadge } from '../../components/StatusBadge';

interface PurposeRow {
  purpose_id: string;
  name: string;
  description: string | null;
  retention_class: string;
  jurisdictions: string[] | null;
}

interface ReceiptRow {
  receipt_id: string;
  subject_persona_id: string;
  purpose_id: string;
  status: string;
  granted_at: string;
  revoked_at: string | null;
}

const TENANT_ID = process.env.TENANT_ADMIN_TENANT_ID ?? '';

async function fetchPurposes(): Promise<PurposeRow[]> {
  if (!TENANT_ID) return [];
  try {
    const res = await fetch(
      `${process.env.NEXT_PUBLIC_GATEWAY_URL}/api/consent/purposes?tenant_id=${encodeURIComponent(TENANT_ID)}`,
      { cache: 'no-store' },
    );
    if (!res.ok) return [];
    return (await res.json()).data ?? [];
  } catch { return []; }
}

async function fetchReceipts(q: { subject_persona_id?: string; purpose_id?: string }): Promise<ReceiptRow[]> {
  if (!TENANT_ID) return [];
  const qs = new URLSearchParams({ tenant_id: TENANT_ID });
  if (q.subject_persona_id) qs.set('subject_persona_id', q.subject_persona_id);
  if (q.purpose_id) qs.set('purpose_id', q.purpose_id);
  try {
    const res = await fetch(
      `${process.env.NEXT_PUBLIC_GATEWAY_URL}/api/consent/receipts?${qs.toString()}`,
      { cache: 'no-store' },
    );
    if (!res.ok) return [];
    return (await res.json()).data ?? [];
  } catch { return []; }
}

async function revokeAction(formData: FormData): Promise<void> {
  'use server';
  const receipt_id = String(formData.get('receipt_id') ?? '');
  await fetch(
    `${process.env.NEXT_PUBLIC_GATEWAY_URL}/api/consent/receipts/${encodeURIComponent(receipt_id)}/revoke`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ reason: String(formData.get('reason') ?? 'tenant-admin revoke') }),
    },
  );
  revalidatePath('/consent');
}

export default async function ConsentPage({
  searchParams,
}: {
  searchParams: { subject_persona_id?: string; purpose_id?: string };
}): Promise<JSX.Element> {
  const [purposes, receipts] = await Promise.all([fetchPurposes(), fetchReceipts(searchParams)]);
  return (
    <div>
      <PageHeader title="Consent" description="Consent purposes registered for this tenant + receipts granted under each." />

      <h2 className="mb-3 text-lg font-semibold">Purposes</h2>
      <div className="mb-6 rounded-lg border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Purpose</TableHead>
              <TableHead>Name</TableHead>
              <TableHead>Description</TableHead>
              <TableHead>Retention</TableHead>
              <TableHead>Jurisdictions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {purposes.length === 0 && (
              <TableRow><TableCell colSpan={5} className="text-muted-foreground">No purposes registered.</TableCell></TableRow>
            )}
            {purposes.map((p) => (
              <TableRow key={p.purpose_id}>
                <TableCell className="font-mono text-[11px]">{p.purpose_id}</TableCell>
                <TableCell>{p.name}</TableCell>
                <TableCell className="text-xs text-muted-foreground">{p.description ?? '—'}</TableCell>
                <TableCell>{p.retention_class}</TableCell>
                <TableCell className="text-xs">{p.jurisdictions?.join(', ') ?? '—'}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>

      <h2 className="mb-3 text-lg font-semibold">Receipts</h2>
      <form method="get" className="mb-3 flex flex-wrap gap-2">
        <Input name="subject_persona_id" defaultValue={searchParams.subject_persona_id} placeholder="subject persona_id" className="w-72" />
        <Input name="purpose_id" defaultValue={searchParams.purpose_id} placeholder="purpose_id" className="w-60" />
        <Button type="submit">Filter</Button>
      </form>
      <div className="rounded-lg border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Receipt</TableHead>
              <TableHead>Subject</TableHead>
              <TableHead>Purpose</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Granted</TableHead>
              <TableHead></TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {receipts.length === 0 && (
              <TableRow><TableCell colSpan={6} className="text-muted-foreground">No receipts.</TableCell></TableRow>
            )}
            {receipts.map((r) => (
              <TableRow key={r.receipt_id}>
                <TableCell className="font-mono text-[11px]">{r.receipt_id}</TableCell>
                <TableCell className="font-mono text-[11px]">{r.subject_persona_id}</TableCell>
                <TableCell className="text-xs">{r.purpose_id}</TableCell>
                <TableCell><StatusBadge status={r.status} /></TableCell>
                <TableCell className="text-xs text-muted-foreground">{new Date(r.granted_at).toLocaleString()}</TableCell>
                <TableCell>
                  {r.status === 'granted' && (
                    <form action={revokeAction} className="flex items-center gap-2">
                      <input type="hidden" name="receipt_id" value={r.receipt_id} />
                      <Input name="reason" placeholder="reason" required minLength={4} className="h-8 w-36" />
                      <Button type="submit" size="sm" variant="ghost" className="text-destructive hover:text-destructive">Revoke</Button>
                    </form>
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
