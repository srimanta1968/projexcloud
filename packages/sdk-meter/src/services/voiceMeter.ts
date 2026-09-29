import { dataService } from '@projexlight/db-runtime';
import { report } from './meterGate';

/**
 * AI voice minute metering (VA·E7 · TK-4503).
 *
 * Every ended AI call is metered once as voice.minute.inbound or voice.minute.outbound:
 *   * duration is rounded UP to 6-second blocks (a 7 s call bills 12 s = 0.2 min);
 *   * test sessions (is_test) are never metered;
 *   * a call with no duration (never connected) bills nothing;
 *   * the meter.voice_call_meter primary key makes it idempotent — repeated "ended"
 *     reports never bill twice.
 * The usage event goes through the standard two-phase gate (report -> usage.events.v1 ->
 * meter-collector -> usage ledger -> invoice), exactly like every other SKU, so voice minutes
 * land on the invoice beside the rest of the tenant's usage.
 */

export const VOICE_SKU = {
  inbound: 'voice.minute.inbound',
  outbound: 'voice.minute.outbound',
} as const;

export const VOICE_BILLING_BLOCK_S = 6;

export interface VoiceCallForMetering {
  call_id: string;
  tenant_id: string;
  agent_id?: string | null;
  direction: 'inbound' | 'outbound';
  is_test: boolean;
  duration_s: number | null;
  ended_at?: string | Date | null;
}

export interface VoiceMeterResult {
  metered: boolean;
  reason?: 'test_session' | 'no_duration' | 'already_metered';
  sku?: string;
  billable_seconds?: number;
  minutes?: number;
}

/** Seconds billed for a call: rounded up to whole 6-second blocks. */
export function billableSeconds(durationS: number): number {
  if (!Number.isFinite(durationS) || durationS <= 0) return 0;
  return Math.ceil(durationS / VOICE_BILLING_BLOCK_S) * VOICE_BILLING_BLOCK_S;
}

/** Meters one ended AI call (idempotent). */
export async function meterVoiceCall(call: VoiceCallForMetering): Promise<VoiceMeterResult> {
  if (call.is_test) return { metered: false, reason: 'test_session' };
  const duration = call.duration_s ?? 0;
  const billable = billableSeconds(duration);
  if (billable === 0) return { metered: false, reason: 'no_duration' };
  const sku = call.direction === 'inbound' ? VOICE_SKU.inbound : VOICE_SKU.outbound;
  const minutes = billable / 60;
  const endedAt = call.ended_at ? new Date(call.ended_at) : new Date();

  const row = await dataService.one<{ call_id: string }>(
    `INSERT INTO meter.voice_call_meter (call_id, tenant_id, agent_id, sku, duration_s, billable_seconds, minutes, ended_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (call_id) DO NOTHING
     RETURNING call_id`,
    [call.call_id, call.tenant_id, call.agent_id ?? null, sku, Math.round(duration), billable, minutes, endedAt],
  );
  if (!row) return { metered: false, reason: 'already_metered' };

  await report({
    sku,
    units: minutes,
    occurred_at: endedAt,
    dimensions: {
      org_id: null,
      app_id: null,
      tenant_id: call.tenant_id,
      bu_id: null,
      persona_id: null,
      encounter_id: null,
      pool_index: 'default',
      region: 'default',
      actor_kind: 'service',
      actor_id: 'sdk-voice-agent',
    },
  });
  return { metered: true, sku, billable_seconds: billable, minutes };
}

export interface VoiceUsageSummary {
  sku: string;
  calls: number;
  billable_seconds: number;
  minutes: number;
}

/**
 * The tenant's metered voice minutes for a period (inclusive dates), per SKU — the voice
 * lines of the invoice draft. Shaped for sdk-billing's generateInvoice usage input.
 */
export async function voiceUsageForPeriod(tenantId: string, periodStart: string, periodEnd: string): Promise<VoiceUsageSummary[]> {
  const rows = await dataService.rows<{ sku: string; calls: string; billable_seconds: string; minutes: string }>(
    `SELECT sku, count(*) AS calls, sum(billable_seconds) AS billable_seconds, sum(minutes) AS minutes
       FROM meter.voice_call_meter
      WHERE tenant_id = $1 AND ended_at >= $2::date AND ended_at < ($3::date + interval '1 day')
      GROUP BY sku ORDER BY sku`,
    [tenantId, periodStart, periodEnd],
  );
  return rows.map((r) => ({ sku: r.sku, calls: Number(r.calls), billable_seconds: Number(r.billable_seconds), minutes: Number(r.minutes) }));
}

/** The SKU carrying a tenant's plan concurrent AI-call cap in meter.quota_policy (TK-4504). */
export const VOICE_CONCURRENCY_SKU = 'voice.concurrent_calls';

export interface VoiceConcurrencyPolicy {
  /** Concurrent calls the plan allows; null = unlimited. */
  hard_cap: number | null;
  /** Active calls at which the tenant is alerted; null = the dialer's 80 % default. */
  soft_cap: number | null;
  /** 'tenant' when the tenant has its own row, 'platform' for the default, 'none' when neither exists. */
  source: 'tenant' | 'platform' | 'none';
}

const POLICY_CACHE_MS = Number(process.env.VOICE_CONCURRENCY_POLICY_CACHE_MS ?? 30_000);
const policyCache = new Map<string, { at: number; policy: VoiceConcurrencyPolicy }>();

/**
 * The tenant's plan concurrency policy: its own voice.concurrent_calls quota row, else the
 * platform default (tenant_id NULL), latest active_from first. Read on every call admission,
 * so it is cached per process for VOICE_CONCURRENCY_POLICY_CACHE_MS (30 s).
 */
export async function voiceConcurrencyPolicy(tenantId: string): Promise<VoiceConcurrencyPolicy> {
  const hit = policyCache.get(tenantId);
  if (hit && Date.now() - hit.at < POLICY_CACHE_MS) return hit.policy;
  const row = await dataService.one<{ tenant_id: string | null; soft_cap: string | null; hard_cap: string | null }>(
    `SELECT tenant_id, soft_cap, hard_cap FROM meter.quota_policy
      WHERE (tenant_id = $1::uuid OR tenant_id IS NULL) AND sku = $2 AND active_from <= now()
      ORDER BY tenant_id NULLS LAST, active_from DESC LIMIT 1`,
    [tenantId, VOICE_CONCURRENCY_SKU],
  );
  const policy: VoiceConcurrencyPolicy = row
    ? {
      hard_cap: row.hard_cap === null ? null : Number(row.hard_cap),
      soft_cap: row.soft_cap === null ? null : Number(row.soft_cap),
      source: row.tenant_id ? 'tenant' : 'platform',
    }
    : { hard_cap: null, soft_cap: null, source: 'none' };
  policyCache.set(tenantId, { at: Date.now(), policy });
  return policy;
}

/** Drops cached policies (after a plan change, or in tests). */
export function clearVoiceConcurrencyPolicyCache(tenantId?: string): void {
  if (tenantId) policyCache.delete(tenantId);
  else policyCache.clear();
}
