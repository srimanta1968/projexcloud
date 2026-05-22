import { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { EVENT_TYPE_REGISTRY } from '@projexlight/contracts';

/**
 * Registers /api/events/* routes. The registry itself lives in
 * @projexlight/contracts as compile-time data; these endpoints expose it
 * for runtime discovery and validation by producers/consumers.
 */
export async function eventRegistryRoutes(app: FastifyInstance): Promise<void> {
  // GET /api/events/types — list all registered event types with metadata
  app.get('/api/events/types', async (_req: FastifyRequest, reply: FastifyReply) => {
    try {
      reply.code(200).send({
        data: {
          count: Object.keys(EVENT_TYPE_REGISTRY).length,
          types: Object.values(EVENT_TYPE_REGISTRY),
        },
      });
    } catch (err) {
      _req.log.error(err);
      if (!reply.sent) reply.code(500).send({ error: 'InternalError' });
    }
  });

  // GET /api/events/types/:type — lookup a single event type
  app.get('/api/events/types/:type', async (req: FastifyRequest<{ Params: { type: string } }>, reply: FastifyReply) => {
    try {
      const meta = EVENT_TYPE_REGISTRY[req.params.type];
      if (!meta) {
        reply.code(404).send({
          error: 'UnregisteredEventType',
          details: [`event_type '${req.params.type}' is not registered`],
        });
        return;
      }
      reply.code(200).send({ data: meta });
    } catch (err) {
      req.log.error(err);
      if (!reply.sent) reply.code(500).send({ error: 'InternalError' });
    }
  });
}
