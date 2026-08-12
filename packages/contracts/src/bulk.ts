/**
 * The shared shape for bulk check endpoints (`POST <path>/bulk`).
 *
 * WHY ONE ENVELOPE RATHER THAN FOUR
 * ---------------------------------
 * The Channel Decision composer calls four different SDKs per subject — consent,
 * policy, deliverability, send-window — and threads their verdicts into a single
 * decision. If each SDK invented its own batch shape, the composer would need four
 * result adapters, and the failure semantics (which the callers actually depend on)
 * would drift apart the first time one of them was changed in isolation.
 *
 * THE TWO PROPERTIES CALLERS DEPEND ON
 * ------------------------------------
 * 1. ORDER IS PRESERVED, and every item also carries its own `index`. Position
 *    alone is fragile — a caller that filters before zipping silently misaligns
 *    subjects with verdicts, and a misaligned consent verdict means mailing
 *    somebody who withdrew. The explicit index makes the misalignment impossible
 *    to introduce by accident rather than merely unlikely.
 *
 * 2. FAILURE IS PER ITEM, NEVER PER BATCH. One unresolvable subject reports
 *    `ok: false` in its own slot and the other N-1 verdicts still return. A batch
 *    that fails whole is a campaign check that fails whole, which is a campaign
 *    that silently does not go out — the loudest possible failure mode for the
 *    quietest possible cause (one malformed id in ten thousand).
 *
 * The envelope itself is still rejected with 400 for the errors that make the
 * request meaningless rather than partly wrong: a missing/!array `items`, an empty
 * batch, or one over MAX_BULK_ITEMS. Those are caller bugs, not subject data.
 */

/** Per-request ceiling. A 100k audience is 100 calls per check — a paged operation. */
export const MAX_BULK_ITEMS = 1000;

/** One item's verdict. `T` is the per-endpoint verdict body. */
export type BulkItemResult<T> =
  | ({ index: number; ok: true } & T)
  | {
      index: number;
      ok: false;
      /** Stable, machine-readable. `VALIDATION_ERROR` for a malformed item. */
      error_code: string;
      error: string;
    };

export interface BulkResponse<T> {
  results: BulkItemResult<T>[];
  summary: {
    requested: number;
    succeeded: number;
    failed: number;
  };
}

/** Envelope-level rejection — the whole request is unusable, so nothing is evaluated. */
export interface BulkEnvelopeError {
  ok: false;
  error: string;
  details: string[];
}

/**
 * Validates the `{ items: [...] }` envelope. Returns the raw items untouched —
 * per-item validation belongs to the endpoint, because only it knows what a
 * subject looks like, and an item rejected here would lose its slot in the
 * results array.
 */
export function parseBulkEnvelope(
  body: unknown,
  max: number = MAX_BULK_ITEMS,
): { ok: true; items: unknown[] } | BulkEnvelopeError {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { ok: false, error: 'ValidationError', details: ['body must be an object with an items[] array'] };
  }
  const items = (body as { items?: unknown }).items;
  if (!Array.isArray(items)) {
    return { ok: false, error: 'ValidationError', details: ['items must be an array'] };
  }
  if (items.length === 0) {
    // Not silently 200-with-nothing: an empty batch is almost always a caller that
    // built its subject list wrong, and answering "0 of 0 succeeded" would let a
    // campaign report a clean check having evaluated nobody.
    return { ok: false, error: 'ValidationError', details: ['items must not be empty'] };
  }
  if (items.length > max) {
    return {
      ok: false,
      error: 'ValidationError',
      details: [`items exceeds the per-request maximum of ${max}; page the batch`],
    };
  }
  return { ok: true, items };
}

/** Builds the response envelope from per-item results, computing the summary. */
export function bulkResponse<T>(results: BulkItemResult<T>[]): BulkResponse<T> {
  const succeeded = results.filter((r) => r.ok).length;
  return {
    results,
    summary: { requested: results.length, succeeded, failed: results.length - succeeded },
  };
}

/** Convenience constructor for a per-item failure. */
export function bulkItemError(index: number, error_code: string, error: string): BulkItemResult<never> {
  return { index, ok: false, error_code, error };
}
