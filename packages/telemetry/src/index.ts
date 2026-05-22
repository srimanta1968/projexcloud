/**
 * @projexlight/telemetry — OTel + Langfuse wiring + envelope-context propagation.
 * P1 ships a minimal stub: a context carrier consumers can attach to spans and
 * logs. Full OTel exporter wiring lands in P6A (sdk-trace).
 */

import crypto from 'crypto';

export interface EnvelopeContext {
  trace_id: string;
  span_id: string;
  org_id: string | null;
  app_id: string | null;
  tenant_id: string | null;
  bu_id: string | null;
  persona_id: string | null;
  encounter_id: string | null;
  region: string | null;
  pool_index: string | null;
  actor_kind: 'human' | 'service' | 'agent';
  actor_id: string;
}

/**
 * Creates a fresh telemetry envelope. Use at the edge of every request so
 * downstream SDK calls inherit the same trace/span IDs.
 */
export function createEnvelope(seed: Partial<EnvelopeContext> = {}): EnvelopeContext {
  return {
    trace_id: seed.trace_id ?? crypto.randomUUID(),
    span_id: seed.span_id ?? crypto.randomUUID().slice(0, 16),
    org_id: seed.org_id ?? null,
    app_id: seed.app_id ?? null,
    tenant_id: seed.tenant_id ?? null,
    bu_id: seed.bu_id ?? null,
    persona_id: seed.persona_id ?? null,
    encounter_id: seed.encounter_id ?? null,
    region: seed.region ?? null,
    pool_index: seed.pool_index ?? null,
    actor_kind: seed.actor_kind ?? 'service',
    actor_id: seed.actor_id ?? 'unknown',
  };
}

/**
 * Stub logger used until P6A wires Loki/Grafana Cloud. Emits structured
 * key=value lines to stdout that match the OTel attribute shape.
 */
type LogCtx = Partial<EnvelopeContext> & Record<string, unknown>;

export const log = {
  info(message: string, ctx?: LogCtx): void {
    write('INFO', message, ctx);
  },
  warn(message: string, ctx?: LogCtx): void {
    write('WARN', message, ctx);
  },
  error(message: string, err?: unknown, ctx?: LogCtx): void {
    const errMsg = err instanceof Error ? `${err.name}: ${err.message}` : String(err ?? '');
    write('ERROR', `${message} ${errMsg}`.trim(), ctx);
  },
};

function write(level: string, message: string, ctx?: LogCtx): void {
  const parts: string[] = [`level=${level}`, `msg="${message.replace(/"/g, '\\"')}"`];
  if (ctx) {
    for (const [k, v] of Object.entries(ctx)) {
      if (v != null) parts.push(`${k}=${typeof v === 'string' ? `"${v}"` : v}`);
    }
  }
  console.log(parts.join(' '));
}
