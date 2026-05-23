import { dataService } from '@projexlight/db-runtime';
import type { ShowbackInput, ShowbackResult, ShowbackRow } from '../models/billing.model';

/**
 * Showback service per FR-BIL-5 — THE wedge vs hyperscalers.
 *
 * Aggregates billing.line_item across arbitrary (app, BU, persona-kind,
 * encounter, sku, actor_kind) splits. Hyperscaler bills give one bottom-
 * line number; ProjexCloud customers see exactly which app + business unit
 * + persona-kind + encounter generated each dollar.
 *
 * Restricted to columns we know exist in billing.line_item; ad-hoc fields
 * would require a separate cross-tenant FK index strategy and are out of
 * scope for v1.
 */

const ALLOWED_DIMS: ShowbackInput['group_by'][number][] = [
  'app_id', 'bu_id', 'persona_kind', 'encounter_id', 'sku', 'actor_kind',
];

export async function computeShowback(input: ShowbackInput): Promise<ShowbackResult> {
  const validDims = (input.group_by ?? []).filter((d) => ALLOWED_DIMS.includes(d));
  if (validDims.length === 0) validDims.push('sku');

  // Defensive: ensure dimension list comes from a fixed allow-list so this
  // can't be tricked into selecting unsupported / sensitive columns.
  const dimSql = validDims.map((d) => `COALESCE(li.${d}, '_null_') AS ${d}`).join(', ');
  const groupSql = validDims.join(', ');

  const rows = await dataService.rows<Record<string, string>>(
    `SELECT ${dimSql},
            SUM(li.units)::float8  AS units,
            SUM(li.amount)::float8 AS amount
       FROM billing.line_item li
       JOIN billing.invoice    inv ON inv.invoice_id = li.invoice_id
      WHERE inv.tenant_id = $1
        AND inv.period_start >= $2
        AND inv.period_end   <= $3
        AND inv.status IN ('finalized','paid')
      GROUP BY ${groupSql}
      ORDER BY amount DESC`,
    [input.tenant_id, input.period_start, input.period_end],
  );

  let total = 0;
  const out: ShowbackRow[] = rows.map((r) => {
    const dims: Record<string, string | null> = {};
    for (const d of validDims) {
      const v = r[d] as string;
      dims[d] = v === '_null_' ? null : v;
    }
    const amount = Number(r.amount);
    total += amount;
    return {
      dim_key: validDims.map((d) => dims[d] ?? '*').join('|'),
      dimensions: dims,
      units: Number(r.units),
      amount,
    };
  });

  return {
    tenant_id: input.tenant_id,
    period_start: input.period_start,
    period_end: input.period_end,
    rows: out,
    total_amount: round4(total),
  };
}

function round4(n: number): number { return Math.round(n * 10_000) / 10_000; }
