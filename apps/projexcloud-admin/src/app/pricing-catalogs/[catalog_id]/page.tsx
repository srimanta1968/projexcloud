import { revalidatePath } from 'next/cache';
import Link from 'next/link';
import {
  Alert,
  Button,
  Input,
  Select,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@projexlight/design-system';

interface CatalogDetail {
  catalog: {
    catalog_id: string;
    version: number;
    status: 'draft' | 'active' | 'retired';
    effective_from: string;
    effective_to: string | null;
    created_by: string;
    rate_count: number;
  } | null;
  rates: Array<{
    rate_id: string;
    sku: string;
    unit: string;
    mode: string;
    price: number | null;
    margin_pct: number | null;
    tiers: unknown | null;
    updated_at: string | null;
  }>;
}

async function fetchCatalog(catalogId: string): Promise<CatalogDetail> {
  try {
    const res = await fetch(
      `${process.env.NEXT_PUBLIC_GATEWAY_URL}/admin/meter/pricing-catalogs/${encodeURIComponent(catalogId)}`,
      {
        cache: 'no-store',
        headers: { 'x-admin-ops-token': process.env.ADMIN_OPS_TOKEN ?? '' },
      },
    );
    if (!res.ok) return { catalog: null, rates: [] };
    const body = await res.json();
    return body.data ?? { catalog: null, rates: [] };
  } catch {
    return { catalog: null, rates: [] };
  }
}

async function updateRate(formData: FormData): Promise<void> {
  'use server';
  const catalogId = String(formData.get('catalog_id') ?? '');
  const sku = String(formData.get('sku') ?? '');
  const unit = String(formData.get('unit') ?? '');
  const mode = String(formData.get('mode') ?? '');
  const priceStr = String(formData.get('price') ?? '');
  const marginStr = String(formData.get('margin_pct') ?? '');
  const operatorId = String(formData.get('operator_id') ?? 'admin-ui');

  const payload: Record<string, unknown> = { unit, mode, operator_id: operatorId };
  if (priceStr.trim() !== '') payload.price = parseFloat(priceStr);
  if (marginStr.trim() !== '') payload.margin_pct = parseFloat(marginStr);

  await fetch(
    `${process.env.NEXT_PUBLIC_GATEWAY_URL}/admin/meter/pricing-catalogs/${encodeURIComponent(catalogId)}/rates/${encodeURIComponent(sku)}`,
    {
      method: 'PUT',
      headers: {
        'content-type': 'application/json',
        'x-admin-ops-token': process.env.ADMIN_OPS_TOKEN ?? '',
      },
      body: JSON.stringify(payload),
    },
  );
  revalidatePath(`/pricing-catalogs/${catalogId}`);
}

async function setCatalogStatusAction(formData: FormData): Promise<void> {
  'use server';
  const catalogId = String(formData.get('catalog_id') ?? '');
  const status = String(formData.get('status') ?? '');
  const operatorId = String(formData.get('operator_id') ?? 'admin-ui');

  await fetch(
    `${process.env.NEXT_PUBLIC_GATEWAY_URL}/admin/meter/pricing-catalogs/${encodeURIComponent(catalogId)}/status`,
    {
      method: 'PATCH',
      headers: {
        'content-type': 'application/json',
        'x-admin-ops-token': process.env.ADMIN_OPS_TOKEN ?? '',
      },
      body: JSON.stringify({ status, operator_id: operatorId }),
    },
  );
  revalidatePath(`/pricing-catalogs/${catalogId}`);
}

export default async function CatalogDetailPage({
  params,
}: {
  params: { catalog_id: string };
}): Promise<JSX.Element> {
  const { catalog_id } = params;
  const { catalog, rates } = await fetchCatalog(catalog_id);

  if (!catalog) {
    return (
      <div>
        <Link href="/pricing-catalogs" className="text-sm text-primary hover:underline">← Back</Link>
        <h1 className="mt-3 text-2xl font-bold tracking-tight">Catalog not found</h1>
        <p className="mt-2 text-sm text-muted-foreground">The ID <code>{catalog_id}</code> didn&apos;t return a catalog.</p>
      </div>
    );
  }

  const isRetired = catalog.status === 'retired';

  return (
    <div>
      <Link href="/pricing-catalogs" className="text-sm text-primary hover:underline">← Back to catalogs</Link>
      <h1 className="mb-2 mt-2 text-2xl font-bold tracking-tight">{catalog.catalog_id}</h1>
      <div className="mb-4 text-sm text-muted-foreground">
        v{catalog.version} · <strong>{catalog.status}</strong> · effective from{' '}
        {new Date(catalog.effective_from).toLocaleString()} · {rates.length} rates
      </div>

      {!isRetired && (
        <form action={setCatalogStatusAction} className="mb-6 flex items-center gap-2">
          <input type="hidden" name="catalog_id" value={catalog.catalog_id} />
          <input type="hidden" name="operator_id" value="admin-ui" />
          <label className="text-sm">Change status:</label>
          <Select name="status" defaultValue={catalog.status} className="w-56">
            <option value="draft">draft</option>
            <option value="active">active</option>
            <option value="retired">retired (immutable)</option>
          </Select>
          <Button type="submit" size="sm">Save status</Button>
        </form>
      )}

      {isRetired && (
        <Alert variant="warning" className="mb-4">
          This catalog is retired — rate edits are blocked at the API layer for billing-audit
          immutability. Create a new catalog version to roll prices forward.
        </Alert>
      )}

      <h2 className="mb-3 mt-6 text-lg font-semibold">Rates</h2>
      <div className="rounded-lg border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>SKU</TableHead>
              <TableHead>Unit</TableHead>
              <TableHead>Mode</TableHead>
              <TableHead>Price</TableHead>
              <TableHead>Margin %</TableHead>
              <TableHead>Updated</TableHead>
              <TableHead></TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rates.map((r) => (
              <TableRow key={r.rate_id}>
                <TableCell className="font-mono text-xs">{r.sku}</TableCell>
                <TableCell>
                  <Input form={`f-${r.rate_id}`} name="unit" defaultValue={r.unit} disabled={isRetired} className="h-8 w-24" />
                </TableCell>
                <TableCell>
                  <Input form={`f-${r.rate_id}`} name="mode" defaultValue={r.mode} disabled={isRetired} className="h-8 w-40" />
                </TableCell>
                <TableCell>
                  <Input form={`f-${r.rate_id}`} name="price" type="number" step="0.000001" defaultValue={r.price ?? ''} disabled={isRetired} className="h-8 w-28" />
                </TableCell>
                <TableCell>
                  <Input form={`f-${r.rate_id}`} name="margin_pct" type="number" step="0.01" defaultValue={r.margin_pct ?? ''} disabled={isRetired} className="h-8 w-24" />
                </TableCell>
                <TableCell className="text-xs text-muted-foreground">
                  {r.updated_at ? new Date(r.updated_at).toLocaleString() : '—'}
                </TableCell>
                <TableCell>
                  <form id={`f-${r.rate_id}`} action={updateRate}>
                    <input type="hidden" name="catalog_id" value={catalog.catalog_id} />
                    <input type="hidden" name="sku" value={r.sku} />
                    <input type="hidden" name="operator_id" value="admin-ui" />
                    <Button type="submit" size="sm" variant="secondary" disabled={isRetired}>Save</Button>
                  </form>
                </TableCell>
              </TableRow>
            ))}
            {rates.length === 0 && (
              <TableRow>
                <TableCell colSpan={7} className="text-muted-foreground">No rates in this catalog yet.</TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
