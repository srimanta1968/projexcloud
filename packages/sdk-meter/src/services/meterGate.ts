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
 * Current-usage resolver — returns accrued units for (tenant, sku) within
 * the current cap window (typically calendar month). Production swaps for
 * a Redis counter; in-process default returns 0 so unconfigured deploys
 * stay ALLOW.
 */
export type CurrentUsageResolver = (tenant_id: string, sku: string) => Promise<number>;

let _softCapResolver: SoftCapResolver = async () => null;
let _currentUsageResolver: CurrentUsageResolver = async () => 0;

/**
 * Gateway boot wires this with sdk-billing.getSoftCap() so the gate honors
 * Finance-managed cap policy without sdk-meter importing sdk-billing.
 */
export function registerSoftCapResolver(resolver: SoftCapResolver): void {
  _softCapResolver = resolver;
}

/**
 * Gateway boot wires this with a Redis counter (production) or a
 * meter.usage_event aggregate (dev). Defaults to 0 = always ALLOW.
 */
export function registerCurrentUsageResolver(resolver: CurrentUsageResolver): void {
  _currentUsageResolver = resolver;
}

/**
 * Two-phase gate, soft-cap mode (P4).
 *
 * Decisions:
 *   - DENY: only when a hard-cap resolver returns true (P7+; not enabled here).
 *   - WARN: soft cap exists AND current_usage >= cap.
 *   - ALLOW: otherwise (no cap configured, or under cap).
 *
 * The middleware below stamps WARN onto X-ProjexCloud-Soft-Cap response
 * header so clients can surface upgrade prompts without parsing bodies.
 */
export async function check(input: GateCheckInput): Promise<GateCheckResult> {
  if (!input.tenant_id) return { decision: 'ALLOW', reason: null };

  const cap = await _softCapResolver(input.tenant_id, input.sku);
  if (cap === null || cap <= 0) return { decision: 'ALLOW', reason: null };

  // Hot-path optimization: prefer the in-memory/Redis counter if installed.
  // Falls through to the registered (potentially Postgres-backed) resolver
  // when no counter is available.
  const counter = getUsageCounter();
  const used = counter
    ? await counter.get(input.tenant_id, input.sku)
    : await _currentUsageResolver(input.tenant_id, input.sku);
  if (used >= cap) {
    return {
      decision: 'WARN',
      reason: `soft cap exceeded for sku '${input.sku}': used ${used} of ${cap}`,
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
