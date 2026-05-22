import crypto from 'crypto';

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
 * In P1 the gate is emit-only — always ALLOW. Soft caps land in P4, hard caps in
 * P7. We still expose check() so consumers wire the call sites now and a future
 * upgrade is mechanical.
 */
export async function check(_input: GateCheckInput): Promise<GateCheckResult> {
  try {
    return { decision: 'ALLOW', reason: null };
  } catch (err) {
    throw err;
  }
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
    return event;
  } catch (err) {
    throw err;
  }
}
