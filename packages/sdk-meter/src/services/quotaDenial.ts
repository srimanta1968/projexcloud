import crypto from 'crypto';
import { getPool } from '@projexlight/db-runtime';
import { report } from './meterGate';

/**
 * Hard-cap denial writer (P7 §12).
 *
 * When the gate returns DENY, the middleware calls this to:
 *   1. INSERT a meter.quota_denial row for audit + tenant-admin triage.
 *   2. Emit a usage.hardcap.exceeded.v1 envelope so alerting + dashboards
 *      see the denial in real time.
 *
 * Idempotency: best-effort. The denial row is one per request; the event
 * emitter is async + non-blocking so a Kafka outage never holds the 429
 * response. The 24h request_count_24h is computed from meter.usage_event
 * counts (fall back to 0 if the query fails — never block the response).
 */
export interface RecordDenialInput {
  tenant_id: string;
  sku: string;
  /** Foreign-key into meter.quota_policy.policy_id; null if not yet resolved. */
  policy_id?: string | null;
  /** Optional pre-computed 24h count; if omitted, query meter.usage_event. */
  request_count_24h?: number;
  trace_id?: string | null;
  pool_index?: string;
  region?: string;
}

export interface DenialRow {
  denial_id: string;
  tenant_id: string;
  sku: string;
  policy_id: string | null;
  denied_at: string;
  request_count_24h: number;
  operator_override_until: string | null;
}

async function resolvePolicyId(tenantId: string, sku: string): Promise<string | null> {
  try {
    const pool = getPool();
    const { rows } = await pool.query<{ policy_id: string }>(
      `SELECT policy_id FROM meter.quota_policy
        WHERE (tenant_id = $1::uuid OR tenant_id IS NULL) AND sku = $2
        ORDER BY tenant_id NULLS LAST LIMIT 1`,
      [tenantId, sku],
    );
    return rows[0]?.policy_id ?? null;
  } catch {
    return null;
  }
}

async function resolveRequestCount24h(tenantId: string, sku: string): Promise<number> {
  try {
    const pool = getPool();
    const { rows } = await pool.query<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM meter.usage_event
        WHERE tenant_id = $1::uuid AND sku = $2
          AND occurred_at >= now() - interval '24 hours'`,
      [tenantId, sku],
    );
    return parseInt(rows[0]?.n ?? '0', 10);
  } catch {
    return 0;
  }
}

/**
 * Persist the denial row + emit the regulated event. Never throws — denial
 * recording must not block the 429 response.
 */
export async function recordQuotaDenial(input: RecordDenialInput): Promise<DenialRow | null> {
  const denialId = `qd_${crypto.randomBytes(10).toString('hex')}`;
  const policyId = input.policy_id ?? (await resolvePolicyId(input.tenant_id, input.sku));
  const count24h = input.request_count_24h ?? (await resolveRequestCount24h(input.tenant_id, input.sku));

  let denial: DenialRow | null = null;
  try {
    const pool = getPool();
    const { rows } = await pool.query<{ denied_at: Date }>(
      `INSERT INTO meter.quota_denial
         (denial_id, tenant_id, sku, policy_id, request_count_24h)
       VALUES ($1, $2::uuid, $3, $4, $5)
       RETURNING denied_at`,
      [denialId, input.tenant_id, input.sku, policyId, count24h],
    );
    denial = {
      denial_id: denialId,
      tenant_id: input.tenant_id,
      sku: input.sku,
      policy_id: policyId,
      denied_at: rows[0].denied_at.toISOString(),
      request_count_24h: count24h,
      operator_override_until: null,
    };
  } catch (err) {
    console.warn('[sdk-meter] quota_denial insert failed:', (err as Error).message);
  }

  // Emit the hardcap event via the existing usage emitter so it flows on
  // the same Kafka topic as usage.event.v1. Best-effort, never blocks.
  try {
    await report({
      sku: input.sku,
      units: 0,
      dimensions: {
        org_id: null,
        app_id: null,
        tenant_id: input.tenant_id,
        bu_id: null,
        persona_id: null,
        encounter_id: null,
        pool_index: input.pool_index ?? 'unknown',
        region: input.region ?? 'unknown',
        actor_kind: 'service',
        actor_id: 'sdk-meter:hardcap-denial',
      },
      trace_id: input.trace_id ?? null,
    });
  } catch (err) {
    console.warn('[sdk-meter] hardcap emit failed:', (err as Error).message);
  }

  return denial;
}
