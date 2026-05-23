import { FastifyInstance } from 'fastify';
import { requireAuth } from '@projexlight/sdk-identity';
import {
  generateInvoiceHandler,
  liveMeterHandler,
  repriceDryRunHandler,
  showbackHandler,
} from './handlers/billingController';

/**
 * Registers /api/billing/* routes per P4-Operational-Billing §9.
 */
export async function registerRoutes(app: FastifyInstance): Promise<void> {
  app.post('/api/billing/invoices/generate', { preHandler: requireAuth }, async (req, reply) => {
    try { await generateInvoiceHandler(req, reply); }
    catch (err) { req.log.error(err); if (!reply.sent) reply.code(500).send({ error: 'InternalError' }); }
  });

  app.get('/api/billing/live', { preHandler: requireAuth }, async (req, reply) => {
    try { await liveMeterHandler(req as never, reply); }
    catch (err) { req.log.error(err); if (!reply.sent) reply.code(500).send({ error: 'InternalError' }); }
  });

  app.post('/api/billing/reprice-dry-run', { preHandler: requireAuth }, async (req, reply) => {
    try { await repriceDryRunHandler(req, reply); }
    catch (err) { req.log.error(err); if (!reply.sent) reply.code(500).send({ error: 'InternalError' }); }
  });

  app.get('/api/billing/showback', { preHandler: requireAuth }, async (req, reply) => {
    try { await showbackHandler(req as never, reply); }
    catch (err) { req.log.error(err); if (!reply.sent) reply.code(500).send({ error: 'InternalError' }); }
  });
}
