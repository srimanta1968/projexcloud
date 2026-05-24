import { getPool } from '@projexlight/db-runtime';
import { report } from './meterGate';

/**
 * Hard-cap override producer (P7 §12 admin path).
 *
 * Lets an operator temporarily lift a denied tenant's hard cap so the
 * tenant can keep working while billing negotiates an upgrade. Writes
 * to meter.quota_denial.operator_override_until and emits
 * usage.hardcap.override.applied.v1 for audit + dashboards.
 *
 * Safety: caller must be authenticated as an operator at the gateway
 * layer (ADMIN_OPS_TOKEN). This module does NOT do authz — it's a
 * pure data-layer helper. The endpoint that calls it is gated.
 */

export interface ApplyHardCapOverrideInput {
  tenant_id: string;
  sku: string;
  /** ISO-8601 timestamp; override expires at this time. */
  until: string;
  /** Operator persona_id from the ADMIN_OPS_TOKEN context. */
  operator_id: string;
  /** Short rationale, persisted as an audit comment. */
  reason: string;
  trace_id?: string | null;
}

export interface HardCapOverrideResult {
  /** Number of meter.quota_denial rows updated (typically the count for the
   *  trailing 24h denial cluster). 0 means no denials matched. */
  updated_rows: number;
  until: string;
}

/**
 * Apply (or extend) an override for the most-recent denials of a
 * (tenant, sku) cluster. Returns the update count + the effective until.
 */
export async function applyHardCapOverride(
  input: ApplyHardCapOverrideInput,
): Promise<HardCapOverrideResult> {
  const pool = getPool();
  const { rowCount } = await pool.query(
    `UPDATE meter.quota_denial
        SET operator_override_until = $3::timestamptz
      WHERE tenant_id = $1::uuid AND sku = $2
        AND denied_at >= now() - interval '24 hours'`,
    [input.tenant_id, input.sku, input.until],
  );

  // Emit regulated event so audit + ops dashboards see the override.
  try {
    await report({
      sku: input.sku,
      units: 0,
      dimensions: {
        org_id: null,
        app_id: null,
        tenant_id: input.tenant_id,
        bu_id: null,
        persona_id: input.operator_id,
        encounter_id: null,
        pool_index: 'unknown',
        region: 'unknown',
        actor_kind: 'human',
        actor_id: input.operator_id,
      },
      trace_id: input.trace_id ?? null,
    });
  } catch (err) {
    console.warn('[sdk-meter] hardcap-override emit failed:', (err as Error).message);
  }

  return { updated_rows: rowCount ?? 0, until: input.until };
}
