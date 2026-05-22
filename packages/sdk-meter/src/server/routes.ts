import { FastifyInstance } from 'fastify';

/**
 * Registers /api/meter/* routes. The meter SDK's primary surface is the
 * middleware, not HTTP routes; this exposes a health/diagnostic endpoint
 * for now. Customer-facing /billing/live and /billing/verify land in P4 with
 * sdk-billing.
 */
export async function registerRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/meter/health', async () => ({ sdk: 'sdk-meter', mode: 'emit-only', status: 'ok' }));
}
