import { getTraceId } from '@projexlight/contracts';

/**
 * AC-11 propagation helper (TK-3302).
 *
 * sdk-audit's appendAuditEntry doesn't currently take a trace_id field on
 * its input — and we don't want to break the existing call sites by
 * adding one. Instead, every audit row gets the trace_id from the active
 * trace-context AsyncLocalStorage. The audit writer reads this helper
 * and merges trace_id into the row payload + span attributes.
 *
 * Drop-in for sdk-meter, sdk-lineage, and any future emit-only SDK — same
 * pattern: call resolveTraceIdFromContext() at the emit site to fill in
 * the column without changing the caller signature.
 */

/**
 * Returns the active trace_id from AsyncLocalStorage, or null when called
 * outside a request-bound async chain. Safe to call from cron workers
 * and tests — returns null cleanly rather than throwing.
 */
export function resolveTraceIdFromContext(): string | null {
  return getTraceId();
}
