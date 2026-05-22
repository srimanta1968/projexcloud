import { FastifyReply, FastifyRequest } from 'fastify';
import { check, report } from '../services/meterGate';
import type { MeterDimensions } from '../services/meterGate';

export interface MeterRouteConfig {
  sku: string;
  resolveDimensions: (req: FastifyRequest) => MeterDimensions;
}

declare module 'fastify' {
  interface FastifyRequest {
    meterStartedAt?: number;
  }
}

/**
 * Returns a Fastify preHandler that runs Phase 1 check() before the handler
 * fires. The matching onResponse hook (registered separately by registerMeter)
 * runs Phase 2 report() with measured latency.
 */
export function meterPreHandler(config: MeterRouteConfig) {
  return async (req: FastifyRequest, reply: FastifyReply): Promise<void> => {
    try {
      const dims = config.resolveDimensions(req);
      const decision = await check({ sku: config.sku, tenant_id: dims.tenant_id });
      if (decision.decision === 'DENY') {
        reply.code(429).send({
          error: 'QuotaExceeded',
          details: [decision.reason ?? 'Hard cap reached'],
        });
        return;
      }
      req.meterStartedAt = Date.now();
    } catch (err) {
      req.log.error(err);
    }
  };
}

/**
 * Returns an onResponse hook that emits UsageEvent.v1 with measured latency
 * after the handler completes. Pair with `meterPreHandler` on the same route.
 */
export function meterOnResponse(config: MeterRouteConfig) {
  return async (req: FastifyRequest, reply: FastifyReply): Promise<void> => {
    try {
      const dims = config.resolveDimensions(req);
      const latency_ms = req.meterStartedAt ? Date.now() - req.meterStartedAt : 0;
      await report({
        sku: config.sku,
        units: 1,
        dimensions: { ...dims, latency_ms },
        occurred_at: new Date(),
      });
    } catch (err) {
      req.log.error(err);
    }
  };
}
