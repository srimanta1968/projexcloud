/**
 * P10/E8 — observability taxonomy + lightweight OTel span propagation.
 *
 * The 8-type taxonomy (Analyze2 §3.11 / Reality Report v2 §4.7) groups every
 * signal. Spans carry W3C-style trace context (trace_id + parent span) so a
 * single trace_id spans frontend → gateway → policy → MDM → consent → DB; a
 * pluggable exporter forwards finished spans to sdk-trace / an OTel collector.
 */

import crypto from 'crypto';
import type { EnvelopeContext } from './index';

export const OBSERVABILITY_TYPES = [
  'infra',
  'service',
  'security',
  'data',
  'mdm',
  'policy',
  'consent',
  'audit',
] as const;
export type ObservabilityType = (typeof OBSERVABILITY_TYPES)[number];

export interface FinishedSpan {
  trace_id: string;
  span_id: string;
  parent_span_id: string | null;
  name: string;
  taxonomy: ObservabilityType;
  start_ms: number;
  duration_ms: number;
  status: 'ok' | 'error';
  attributes: Record<string, unknown>;
}

type SpanExporter = (span: FinishedSpan) => void;
const exporters: SpanExporter[] = [];

/** Registers a finished-span exporter (e.g. sdk-trace → ClickHouse / OTLP). */
export function addSpanExporter(fn: SpanExporter): void {
  exporters.push(fn);
}

function newSpanId(): string {
  return crypto.randomUUID().replace(/-/g, '').slice(0, 16);
}

/**
 * Derives a child context that PRESERVES trace_id and links to the parent span.
 * Pass the returned context to downstream SDK calls so the trace is unbroken.
 */
export function childContext(parent: EnvelopeContext, _name: string): EnvelopeContext {
  return { ...parent, span_id: newSpanId() };
}

/**
 * Runs `fn` inside a span. Creates a child context (same trace_id, fresh
 * span_id, parent = the current span), records duration + status, and emits the
 * finished span to all exporters. `fn` receives the child context to propagate.
 */
export async function withSpan<T>(
  name: string,
  taxonomy: ObservabilityType,
  parent: EnvelopeContext,
  fn: (ctx: EnvelopeContext) => Promise<T>,
  attributes: Record<string, unknown> = {},
): Promise<T> {
  const child = childContext(parent, name);
  const start = Date.now();
  let status: 'ok' | 'error' = 'ok';
  try {
    return await fn(child);
  } catch (err) {
    status = 'error';
    throw err;
  } finally {
    const finished: FinishedSpan = {
      trace_id: child.trace_id,
      span_id: child.span_id,
      parent_span_id: parent.span_id ?? null,
      name,
      taxonomy,
      start_ms: start,
      duration_ms: Date.now() - start,
      status,
      attributes,
    };
    for (const exp of exporters) {
      try {
        exp(finished);
      } catch {
        // exporter failures never affect the traced operation
      }
    }
  }
}

/** Serializes trace context to a W3C `traceparent`-style header for propagation. */
export function toTraceparent(ctx: EnvelopeContext): string {
  return `00-${ctx.trace_id.replace(/-/g, '')}-${(ctx.span_id || newSpanId()).padEnd(16, '0').slice(0, 16)}-01`;
}

/** Parses a `traceparent` header into trace_id + parent span_id (best-effort). */
export function fromTraceparent(header: string | undefined): { trace_id: string; span_id: string } | null {
  if (!header) return null;
  const parts = header.split('-');
  if (parts.length < 4) return null;
  return { trace_id: parts[1], span_id: parts[2] };
}
