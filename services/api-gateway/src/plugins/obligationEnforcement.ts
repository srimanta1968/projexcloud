/**
 * P10/E1 — central obligation enforcement for governed reads (FR §11A.3, OC-11).
 *
 * A governed-read handler, after evaluating policy, attaches the decision's
 * obligations to the request:
 *
 *     const decision = await evaluatePolicy(...);
 *     req.governedObligations = decision.obligations;   // may be undefined
 *     return reply.send({ data: rows });
 *
 * This `preSerialization` hook then masks `mask_fields` and drops `row_filter`
 * rows on the response body BEFORE it is serialized — so enforcement happens
 * centrally even if a handler forgets. Requests that never set obligations are
 * untouched (pre-P10 behaviour), keeping the change additive.
 */

import type { FastifyInstance, FastifyPluginCallback } from 'fastify';
import { applyObligations, maskRow, type Obligations } from '@projexlight/contracts';

declare module 'fastify' {
  interface FastifyRequest {
    /** Obligations from this request's governed-read policy decision, if any. */
    governedObligations?: Obligations;
  }
}

/** True for a plain JSON object (not array, Buffer, stream, or null). */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    !Buffer.isBuffer(value) &&
    typeof (value as { pipe?: unknown }).pipe !== 'function'
  );
}

/**
 * Applies obligations to a response payload. Handles the platform's standard
 * `{ data: rows[] }` and `{ data: {...} }` envelopes as well as a bare array or
 * object. Pure — returns a new payload, never mutates the input. Exported for
 * unit testing and reuse by data-reading SDKs that serialize their own bodies.
 */
export function enforceGovernedPayload<T>(payload: T, obligations: Obligations | undefined | null): T {
  if (!obligations) return payload;

  // Bare array body.
  if (Array.isArray(payload)) {
    return applyObligations(payload as Record<string, unknown>[], obligations).rows as unknown as T;
  }

  if (isPlainObject(payload) && 'data' in payload) {
    const data = (payload as Record<string, unknown>).data;
    if (Array.isArray(data)) {
      const enforced = applyObligations(data as Record<string, unknown>[], obligations).rows;
      return { ...payload, data: enforced };
    }
    if (isPlainObject(data)) {
      // Single record: drop it (→ null) if row_filter excludes it, else mask.
      const filter = obligations.row_filter;
      const survives =
        !filter ||
        Object.keys(filter).length === 0 ||
        applyObligations([data], { row_filter: filter }).rows.length === 1;
      if (!survives) return { ...payload, data: null };
      return { ...payload, data: maskRow(data, obligations.mask_fields ?? []) };
    }
    return payload;
  }

  // Bare object body.
  if (isPlainObject(payload)) {
    return maskRow(payload, obligations.mask_fields ?? []) as T;
  }

  return payload;
}

/**
 * Fastify plugin: registers the request decorator + preSerialization hook that
 * enforce obligations on governed reads platform-wide.
 */
export const obligationEnforcementPlugin: FastifyPluginCallback = (app: FastifyInstance, _opts, done) => {
  app.decorateRequest('governedObligations', undefined);

  app.addHook('preSerialization', async (req, _reply, payload) => {
    const obligations = req.governedObligations;
    if (!obligations) return payload;
    return enforceGovernedPayload(payload, obligations);
  });

  done();
};

export default obligationEnforcementPlugin;
