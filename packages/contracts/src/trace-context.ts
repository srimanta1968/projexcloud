import { AsyncLocalStorage } from 'async_hooks';

/**
 * Trace context propagation (AC-11 / TK-3302).
 *
 * Closes the AC-11 gap: every audit / meter / lineage emission from P1–P5
 * SDKs must carry the inbound request's `trace_id`. We provide a single
 * AsyncLocalStorage-backed store so the request entry point sets the
 * trace_id once and every downstream emit reads it without having to
 * thread the value through every function signature.
 *
 * Usage at the entry point (api-gateway pre-handler):
 *   const trace_id = req.headers['x-trace-id'] ?? crypto.randomUUID();
 *   await runWithTraceContext({ trace_id }, () => handler(req, reply));
 *
 * Usage in any SDK emit site:
 *   const ctx = getTraceContext();   // { trace_id, span_id? } | undefined
 *   appendAuditEntry({ ..., trace_id: ctx?.trace_id ?? null });
 *
 * sdk-audit + sdk-meter + sdk-lineage all read from this store via
 * getTraceContext() when no explicit trace_id is passed in the input.
 * That way an existing emit() with no trace_id keyword still propagates.
 */

export interface TraceContext {
  trace_id: string;
  span_id?: string;
  parent_span_id?: string;
}

const storage = new AsyncLocalStorage<TraceContext>();

/** Run `fn` with the given trace context bound to async-local storage. */
export function runWithTraceContext<T>(ctx: TraceContext, fn: () => T): T {
  return storage.run(ctx, fn);
}

/** Returns the active trace context, or `undefined` when called outside a request. */
export function getTraceContext(): TraceContext | undefined {
  return storage.getStore();
}

/** Convenience: returns the active trace_id or `null` for direct nullable assignment. */
export function getTraceId(): string | null {
  return storage.getStore()?.trace_id ?? null;
}

/**
 * Replace the active context's span_id (called when an SDK opens a new
 * span). The trace_id is preserved. Throws if no active context.
 */
export function setSpanId(span_id: string): void {
  const ctx = storage.getStore();
  if (!ctx) throw new Error('[trace-context] no active context — call runWithTraceContext first');
  ctx.parent_span_id = ctx.span_id;
  ctx.span_id = span_id;
}
