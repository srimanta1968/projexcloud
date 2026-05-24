import { revalidatePath } from 'next/cache';
import Link from 'next/link';

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
        <Link href="/pricing-catalogs">← Back</Link>
        <h1>Catalog not found</h1>
        <p>The ID <code>{catalog_id}</code> didn&apos;t return a catalog.</p>
      </div>
    );
  }

  const isRetired = catalog.status === 'retired';

  return (
    <div>
      <Link href="/pricing-catalogs">← Back to catalogs</Link>
      <h1>{catalog.catalog_id}</h1>
      <div style={{ color: '#5a6573', marginBottom: 16 }}>
        v{catalog.version} · <strong>{catalog.status}</strong> · effective from{' '}
        {new Date(catalog.effective_from).toLocaleString()} · {rates.length} rates
      </div>

      {!isRetired && (
        <form action={setCatalogStatusAction} style={{ marginBottom: 24 }}>
          <input type="hidden" name="catalog_id" value={catalog.catalog_id} />
          <input type="hidden" name="operator_id" value="admin-ui" />
          <label style={{ marginRight: 8 }}>Change status:</label>
          <select name="status" defaultValue={catalog.status} style={{ padding: 4 }}>
            <option value="draft">draft</option>
            <option value="active">active</option>
            <option value="retired">retired (immutable)</option>
          </select>
          <button type="submit" style={{ marginLeft: 8, padding: '4px 12px' }}>
            Save status
          </button>
        </form>
      )}

      {isRetired && (
        <div style={{
          background: '#fff4d6', border: '1px solid #e3c47b',
          padding: 12, borderRadius: 4, marginBottom: 16,
        }}>
          This catalog is retired — rate edits are blocked at the API layer for billing-audit
          immutability. Create a new catalog version to roll prices forward.
        </div>
      )}

      <h2 style={{ marginTop: 24 }}>Rates</h2>
      <table style={{ width: '100%', borderCollapse: 'collapse' }}>
        <thead style={{ textAlign: 'left', borderBottom: '1px solid #d7dce4' }}>
          <tr>
            <th style={{ padding: 8 }}>SKU</th>
            <th style={{ padding: 8 }}>Unit</th>
            <th style={{ padding: 8 }}>Mode</th>
            <th style={{ padding: 8 }}>Price</th>
            <th style={{ padding: 8 }}>Margin %</th>
            <th style={{ padding: 8 }}>Updated</th>
            <th style={{ padding: 8 }}></th>
          </tr>
        </thead>
        <tbody>
          {rates.map((r) => (
            <tr key={r.rate_id} style={{ borderBottom: '1px solid #eef0f4' }}>
              <td style={{ padding: 8, fontFamily: 'monospace' }}>{r.sku}</td>
              <td style={{ padding: 8 }}>
                <form action={updateRate} style={{ display: 'contents' }}>
                  <input type="hidden" name="catalog_id" value={catalog.catalog_id} />
                  <input type="hidden" name="sku" value={r.sku} />
                  <input type="hidden" name="operator_id" value="admin-ui" />
                  <input
                    name="unit"
                    defaultValue={r.unit}
                    style={{ width: 80, padding: 2 }}
                    disabled={isRetired}
                  />
                </form>
              </td>
              <td style={{ padding: 8 }}>
                <input
                  form={`f-${r.rate_id}`}
                  name="mode"
                  defaultValue={r.mode}
                  style={{ width: 160, padding: 2 }}
                  disabled={isRetired}
                />
              </td>
              <td style={{ padding: 8 }}>
                <input
                  form={`f-${r.rate_id}`}
                  name="price"
                  type="number"
                  step="0.000001"
                  defaultValue={r.price ?? ''}
                  style={{ width: 100, padding: 2 }}
                  disabled={isRetired}
                />
              </td>
              <td style={{ padding: 8 }}>
                <input
                  form={`f-${r.rate_id}`}
                  name="margin_pct"
                  type="number"
                  step="0.01"
                  defaultValue={r.margin_pct ?? ''}
                  style={{ width: 80, padding: 2 }}
                  disabled={isRetired}
                />
              </td>
              <td style={{ padding: 8, color: '#5a6573', fontSize: 12 }}>
                {r.updated_at ? new Date(r.updated_at).toLocaleString() : '—'}
              </td>
              <td style={{ padding: 8 }}>
                <form id={`f-${r.rate_id}`} action={updateRate}>
                  <input type="hidden" name="catalog_id" value={catalog.catalog_id} />
                  <input type="hidden" name="sku" value={r.sku} />
                  <input type="hidden" name="unit" value={r.unit} />
                  <input type="hidden" name="operator_id" value="admin-ui" />
                  <button type="submit" disabled={isRetired} style={{ padding: '4px 12px' }}>
                    Save
                  </button>
                </form>
              </td>
            </tr>
          ))}
          {rates.length === 0 && (
            <tr>
              <td colSpan={7} style={{ padding: 12, color: '#9aa3b2' }}>
                No rates in this catalog yet.
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}
