import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { Alert, Badge, Button, Input, PageHeader, Select, Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@projexlight/design-system';
import { opsGateway, OpsGatewayError } from '../../../lib/opsGateway';

/**
 * Speech/LLM catalog (VA·E9 · TK-4516): every provider model tenants can build voice stacks
 * from, with its list price and certification. Only CERTIFIED entries are selectable in
 * tenant stacks; revoking one blocks new stacks that use it. Edits are audited as
 * speech.catalog_entry.updated.v1.
 */

interface Entry {
  entry_id: string;
  catalog_key: string;
  layer: string;
  provider: string;
  model: string;
  display_name: string;
  list_price: number;
  unit: string;
  output_list_price: number | null;
  currency: string;
  price_verified_at: string | null;
  certification_status: 'certified' | 'uncertified' | 'revoked';
}

async function updateEntryAction(form: FormData): Promise<void> {
  'use server';
  const id = String(form.get('entry_id') ?? '');
  const patch: Record<string, unknown> = {
    display_name: String(form.get('display_name') ?? '').trim(),
    list_price: Number(form.get('list_price')),
    certification_status: String(form.get('certification_status') ?? ''),
  };
  if (form.get('price_verified') === 'on') patch.price_verified = true;
  let q = '';
  try {
    const r = await opsGateway.patch<{ changes: Record<string, unknown> }>(`/api/admin/speech/catalog/${encodeURIComponent(id)}`, patch);
    q = `saved=${encodeURIComponent(id)}&changed=${Object.keys(r.changes).length}`;
  } catch (err) {
    q = `error=${encodeURIComponent(err instanceof OpsGatewayError ? err.message : 'Could not save the entry')}`;
  }
  revalidatePath('/voice/catalog');
  redirect(`/voice/catalog?${q}`);
}

const VARIANT = { certified: 'success', uncertified: 'secondary', revoked: 'destructive' } as const;

export default async function CatalogPage({ searchParams }: { searchParams: { error?: string; saved?: string; changed?: string; layer?: string } }) {
  let entries: Entry[] = [];
  let error = searchParams.error;
  try {
    const q = searchParams.layer ? `?layer=${encodeURIComponent(searchParams.layer)}` : '';
    entries = (await opsGateway.get<{ entries: Entry[] }>(`/api/admin/speech/catalog${q}`)).entries;
  } catch (err) {
    error = err instanceof OpsGatewayError ? err.message : 'Could not load the catalog';
  }
  return (
    <div>
      <PageHeader title="Voice catalog" description="Provider models for voice stacks: list price and certification. Only certified entries are selectable by tenants." />
      {error ? <Alert variant="destructive" className="mb-3" data-testid="catalog-error">{error}</Alert> : null}
      {searchParams.saved ? <Alert variant="success" className="mb-3" data-testid="catalog-saved">Saved — {searchParams.changed ?? 0} field(s) changed.</Alert> : null}
      <div className="mb-3 flex gap-2 text-sm">
        {['', 'stt', 'tts', 'llm', 'realtime'].map((l) => (
          <a key={l || 'all'} href={l ? `/voice/catalog?layer=${l}` : '/voice/catalog'} className={(searchParams.layer ?? '') === l ? 'font-semibold underline' : 'underline'}>{l || 'all'}</a>
        ))}
      </div>
      <div className="rounded-lg border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Layer</TableHead>
              <TableHead>Provider / model</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Edit (name · price · certification · verified)</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {entries.length === 0 ? <TableRow><TableCell colSpan={4} className="text-muted-foreground">No entries.</TableCell></TableRow> : null}
            {entries.map((e) => (
              <TableRow key={e.entry_id} data-testid={`entry-${e.catalog_key}`}>
                <TableCell>{e.layer}</TableCell>
                <TableCell>
                  <div className="font-medium">{e.provider} / {e.model}</div>
                  <div className="text-xs text-muted-foreground">
                    {e.currency} {e.list_price} per {e.unit}{e.output_list_price !== null ? ` (out ${e.output_list_price})` : ''} ·{' '}
                    {e.price_verified_at ? `verified ${new Date(e.price_verified_at).toLocaleDateString()}` : 'price not verified'}
                  </div>
                </TableCell>
                <TableCell><Badge variant={VARIANT[e.certification_status]} data-testid={`entry-status-${e.catalog_key}`}>{e.certification_status}</Badge></TableCell>
                <TableCell>
                  <form action={updateEntryAction} className="flex flex-wrap items-center gap-2">
                    <input type="hidden" name="entry_id" value={e.entry_id} />
                    <Input name="display_name" defaultValue={e.display_name} className="h-8 w-44" aria-label="Display name" />
                    <Input name="list_price" type="number" step="any" min={0} defaultValue={e.list_price} className="h-8 w-28" aria-label="List price" />
                    <Select name="certification_status" defaultValue={e.certification_status} className="h-8 w-32" aria-label="Certification">
                      <option value="certified">certified</option>
                      <option value="uncertified">uncertified</option>
                      <option value="revoked">revoked</option>
                    </Select>
                    <label className="flex items-center gap-1 text-xs"><input type="checkbox" name="price_verified" /> price verified today</label>
                    <Button type="submit" size="sm">Save</Button>
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
