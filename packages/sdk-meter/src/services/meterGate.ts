import crypto from 'crypto';
import { getUsageCounter } from './usageCounter';

export type GateDecision = 'ALLOW' | 'WARN' | 'DENY';

export interface MeterDimensions {
  org_id: string | null;
  app_id: string | null;
  tenant_id: string | null;
  bu_id: string | null;
  persona_id: string | null;
  encounter_id: string | null;
  pool_index: string;
  region: string;
  actor_kind: 'human' | 'service' | 'agent';
  actor_id: string;
  latency_ms?: number;
  bytes_in?: number;
  bytes_out?: number;
}

export interface UsageEventV1 {
  event_id: string;
  sku: string;
  units: number;
  dimensions: MeterDimensions;
  occurred_at: string;
  trace_id: string | null;
}

export interface GateCheckInput {
  sku: string;
  tenant_id: string | null;
}

export interface GateCheckResult {
  decision: GateDecision;
  reason: string | null;
}

export interface ReportInput {
  sku: string;
  units: number;
  dimensions: MeterDimensions;
  occurred_at?: Date;
  trace_id?: string | null;
}

/**
 * Soft-cap resolver per FR-MET-* / sdk-billing FR-BIL-4 wiring.
 * Returns the configured cap for (tenant, sku) or null when unset.
 */
export type SoftCapResolver = (tenant_id: string, sku: string) => Promise<number | null>;

/**
 * Hard-cap resolver (P7). Returns the configured hard_cap from
 * meter.quota_policy or null when unset. Distinct from the soft cap because
 * a tenant typically has both — soft for WARN, hard for DENY.
 */
export type HardCapResolver = (tenant_id: string, sku: string) => Promise<number | null>;

/**
 * Current-usage resolver — returns accrued units for (tenant, sku) within
 * the current cap window (typically calendar month). Production swaps for
 * a Redis counter; in-process default returns 0 so unconfigured deploys
 * stay ALLOW.
 */
export type CurrentUsageResolver = (tenant_id: string, sku: string) => Promise<number>;

let _softCapResolver: SoftCapResolver = async () => null;
let _hardCapResolver: HardCapResolver = async () => null;
let _currentUsageResolver: CurrentUsageResolver = async () => 0;

/**
 * Gateway boot wires this with sdk-billing.getSoftCap() so the gate honors
 * Finance-managed cap policy without sdk-meter importing sdk-billing.
 */
export function registerSoftCapResolver(resolver: SoftCapResolver): void {
  _softCapResolver = resolver;
}

/**
 * Gateway boot wires this with sdk-billing.getHardCap() (or equivalent
 * reader of meter.quota_policy.hard_cap). Only consulted when
 * METER_MODE=hard-cap; soft-only deploys skip the lookup.
 */
export function registerHardCapResolver(resolver: HardCapResolver): void {
  _hardCapResolver = resolver;
}

/**
 * Gateway boot wires this with a Redis counter (production) or a
 * meter.usage_event aggregate (dev). Defaults to 0 = always ALLOW.
 */
export function registerCurrentUsageResolver(resolver: CurrentUsageResolver): void {
  _currentUsageResolver = resolver;
}

/**
 * The three meter modes per Architecture v3.1 §10A:
 *   - emit-only (P1): record usage, never block.
 *   - soft-cap  (P4): record usage, stamp WARN header at soft cap.
 *   - hard-cap  (P7): record usage, return 429 DENY at hard cap.
 *
 * Default is 'soft-cap' for safety — flipping to 'hard-cap' is an operator
 * action gated by 30+ weeks of soft-cap calibration data (PRD R-1).
 */
export type MeterMode = 'emit-only' | 'soft-cap' | 'hard-cap';

export function getMeterMode(): MeterMode {
  const raw = process.env.METER_MODE;
  if (raw === 'emit-only' || raw === 'soft-cap' || raw === 'hard-cap') return raw;
  return 'soft-cap';
}

/**
 * Two-phase gate.
 *
 * Decisions:
 *   - DENY: METER_MODE=hard-cap AND hard cap exists AND used >= hard cap.
 *   - WARN: METER_MODE in {soft-cap, hard-cap} AND soft cap exists AND used >= soft cap.
 *   - ALLOW: otherwise (emit-only mode, or no cap configured, or under cap).
 *
 * The middleware below stamps WARN onto the X-ProjexCloud-Soft-Cap response
 * header and converts DENY to a 429 QuotaExceeded response (P7).
 */
export async function check(input: GateCheckInput): Promise<GateCheckResult> {
  if (!input.tenant_id) return { decision: 'ALLOW', reason: null };
  const mode = getMeterMode();
  if (mode === 'emit-only') return { decision: 'ALLOW', reason: null };

  // Resolve current usage once for both hard and soft checks.
  const counter = getUsageCounter();
  const used = counter
    ? await counter.get(input.tenant_id, input.sku)
    : await _currentUsageResolver(input.tenant_id, input.sku);

  // Hard cap check first — only in hard-cap mode (P7 mode flip).
  if (mode === 'hard-cap') {
    const hardCap = await _hardCapResolver(input.tenant_id, input.sku);
    if (hardCap !== null && hardCap > 0 && used >= hardCap) {
      return {
        decision: 'DENY',
        reason: `hard cap exceeded for sku '${input.sku}': used ${used} of ${hardCap}`,
      };
    }
  }

  // Soft cap check (applies to both soft-cap and hard-cap modes).
  const softCap = await _softCapResolver(input.tenant_id, input.sku);
  if (softCap === null || softCap <= 0) return { decision: 'ALLOW', reason: null };

  if (used >= softCap) {
    return {
      decision: 'WARN',
      reason: `soft cap exceeded for sku '${input.sku}': used ${used} of ${softCap}`,
    };
  }
  return { decision: 'ALLOW', reason: null };
}

type Emitter = (event: UsageEventV1) => Promise<void> | void;

let _emitter: Emitter = async (_event) => {
  // Default no-op emitter for unit tests. The service wires a Kafka producer
  // via setEmitter() at startup.
};

/**
 * Allows the host service to install a Kafka/Redpanda producer as the emit
 * sink. Must be called before the first report() call in production.
 */
export function setEmitter(emitter: Emitter): void {
  _emitter = emitter;
}

/**
 * Phase 2 of the two-phase gate. Emits a UsageEvent.v1 envelope to the
 * configured sink. Async + non-blocking; never holds up the calling request.
 */
export async function report(input: ReportInput): Promise<UsageEventV1> {
  try {
    const event: UsageEventV1 = {
      event_id: crypto.randomUUID(),
      sku: input.sku,
      units: input.units,
      dimensions: input.dimensions,
      occurred_at: (input.occurred_at ?? new Date()).toISOString(),
      trace_id: input.trace_id ?? null,
    };
    await _emitter(event);

    // Keep the soft-cap counter warm so check() stays O(1) on the gate path.
    // Best-effort: a Redis blip never blocks the request.
    const counter = getUsageCounter();
    if (counter && input.dimensions.tenant_id) {
      counter.incr(input.dimensions.tenant_id, input.sku, input.units).catch((err) => {
        console.warn('[sdk-meter] usage counter incr failed:', (err as Error).message);
      });
    }
    return event;
  } catch (err) {
    throw err;
  }
}
