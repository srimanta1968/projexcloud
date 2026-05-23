import { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { check } from './meterGate';

/**
 * Fastify hook per FR-MET soft-cap mode (P4).
 *
 * Inspects the request route + caller tenant to derive a (sku, tenant_id)
 * pair, calls meterGate.check(), and stamps `X-ProjexCloud-Soft-Cap`
 * onto the response when the gate returns WARN. Never blocks the request
 * — soft caps are advisory until the P7 hard-cap upgrade.
 *
 * Route → SKU mapping is supplied via `routeSkuMap` at install time so
 * sdk-meter stays free of vertical/route knowledge. Routes not in the map
 * skip the check entirely.
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
