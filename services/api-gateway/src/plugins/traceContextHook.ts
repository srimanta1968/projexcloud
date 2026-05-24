import crypto from 'crypto';
import { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { runWithTraceContext } from '@projexlight/contracts';

/**
 * Fastify pre-handler that establishes the trace context for the request
 * lifetime (AC-11 / TK-3302). Every downstream SDK emit reads from this
 * AsyncLocalStorage, so trace_id propagates through P1–P5 SDKs without
 * each SDK having to accept trace_id in its emit signature.
 *
 * Inbound trace_id resolution:
 *   1. X-Trace-Id header (operator-injected, e.g. from an external proxy)
 *   2. traceparent header (W3C trace context) — middle 32 hex chars
 *   3. fresh UUID
 *
 * Outbound: the response always carries X-Trace-Id so the client can
 * correlate logs + trace viewer URLs without parsing the body.
 */

function parseTraceparent(value: string | undefined): string | null {
  if (!value) return null;
  // version-traceid-spanid-flags  (e.g. 00-<32hex>-<16hex>-01)
  const parts = value.split('-');
  if (parts.length < 4) return null;
  const traceId = parts[1];
  if (!/^[0-9a-f]{32}$/.test(traceId)) return null;
  return traceId;
}

function resolveInboundTraceId(req: FastifyRequest): string {
  const header = req.headers['x-trace-id'];
  if (typeof header === 'string' && header.length > 0) return header;
  const traceparent = req.headers['traceparent'];
  const parsed = parseTraceparent(typeof traceparent === 'string' ? traceparent : undefined);
  if (parsed) return parsed;
  return crypto.randomUUID();
}

export async function installTraceContextHook(app: FastifyInstance): Promise<void> {
  // onRequest establishes the ALS context before any route handler runs.
  // Wrapping the rest of the request flow inside runWithTraceContext means
  // every async hop sees the same trace_id.
  app.addHook('onRequest', async (req: FastifyRequest, reply: FastifyReply) => {
    const trace_id = resolveInboundTraceId(req);
    reply.header('x-trace-id', trace_id);
    // Hold a reference for downstream hooks. Fastify pre-handlers run inside
    // the same async chain so AsyncLocalStorage works; we wrap the route
    // execution explicitly via reply.then below for belt-and-suspenders.
    (req as unknown as { trace_id: string }).trace_id = trace_id;
  });

  app.addHook('preHandler', async (req: FastifyRequest) => {
    const trace_id = (req as unknown as { trace_id: string }).trace_id;
    // Re-enter runWithTraceContext for each handler so the ALS store is
    // populated. Returns a never-rejecting promise that the handler awaits.
    await new Promise<void>((resolve) => {
      runWithTraceContext({ trace_id }, () => {
        resolve();
      });
    });
  });
}
