import { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { check, getMeterMode } from './meterGate';
import { recordQuotaDenial } from './quotaDenial';

/**
 * Fastify hook for the unified soft-cap (P4) + hard-cap (P7) meter gate.
 *
 * Inspects the request route + caller tenant to derive a (sku, tenant_id)
 * pair, calls meterGate.check(), and:
 *   - WARN (soft-cap exceeded) → stamps `X-ProjexCloud-Soft-Cap` header
 *     and lets the request through (advisory).
 *   - DENY (hard-cap exceeded, METER_MODE=hard-cap) → returns 429 with a
 *     QuotaExceeded body, writes a meter.quota_denial row, and emits a
 *     usage.hardcap.exceeded.v1 event.
 *   - ALLOW → no-op.
 *
 * Route → SKU mapping is supplied via `routeSkuMap` at install time so
 * sdk-meter stays free of vertical/route knowledge. Routes not in the map
 * skip the check entirely. The hook is installed at onRequest so DENY
 * short-circuits before handler logic runs (latency target ≤ 2ms per
 * PRD §6 NFR; the cap lookup is the main spend).
 */

export interface InstallSoftCapsOptions {
  /** Map of "/api/some/route" → sku string. Routes not listed are skipped. */
  routeSkuMap: Record<string, string>;
}

export function installSoftCapHook(app: FastifyInstance, opts: InstallSoftCapsOptions): void {
  app.addHook('onRequest', async (req: FastifyRequest, reply: FastifyReply) => {
    const sku = resolveSku(req.routeOptions?.url ?? req.url, opts.routeSkuMap);
    if (!sku) return;

    // Avoid importing sdk-identity to keep dep graph one-way; the request
    // auth claim is shaped { tenant_id?: string } at the gateway layer.
    const claims = (req as unknown as { auth?: { tenant_id?: string | null } }).auth;
    const tenant_id = claims?.tenant_id ?? null;
    const result = await check({ sku, tenant_id });

    if (result.decision === 'WARN') {
      reply.header(
        'X-ProjexCloud-Soft-Cap',
        `exceeded; sku=${sku}; reason="${result.reason ?? 'cap exceeded'}"`,
      );
      return;
    }

    if (result.decision === 'DENY') {
      // P7 hard-cap. Record denial (fire-and-forget so the 429 latency
      // stays under the 2ms NFR) and return 429.
      if (tenant_id) {
        const traceId = (req.headers['x-trace-id'] as string | undefined) ?? null;
        void recordQuotaDenial({
          tenant_id,
          sku,
          trace_id: traceId,
        });
      }
      reply.code(429).header('X-ProjexCloud-Quota-Exceeded', sku).send({
        error: 'quota_exceeded',
        sku,
        message: result.reason ?? 'hard cap exceeded',
        meter_mode: getMeterMode(),
      });
    }
  });
}

function resolveSku(routePath: string, map: Record<string, string>): string | null {
  // Direct hit
  if (map[routePath]) return map[routePath];
  // Strip query string + trailing slash and retry
  const clean = routePath.split('?')[0].replace(/\/$/, '');
  return map[clean] ?? null;
}
