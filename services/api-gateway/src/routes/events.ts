import { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { EVENT_TYPE_REGISTRY } from '@projexlight/contracts';
import {
  listEventTypes,
  registerTenantEventType,
  EventTypeRegistrationError,
  type RegisterEventTypeInput,
} from '@projexlight/sdk-audit';

/**
 * Registers /api/events/* routes. The PLATFORM BASELINE registry lives in
 * @projexlight/contracts as compile-time data; a tenant application extends it
 * at runtime through POST /api/events/types, whose rows live in
 * audit.tenant_event_type and are read baseline-first (TK-4144).
 *
 * Until that POST existed these two GETs were the whole surface, which meant a
 * consuming app could DISCOVER the vocabulary but never join it: every append
 * of its own event types 400'd, and because the emit path is non-throwing by
 * design nothing surfaced the rejection — the app reported governed actions as
 * recorded while its audit chain stayed empty.
 */
export async function eventRegistryRoutes(app: FastifyInstance): Promise<void> {
  // GET /api/events/types — the platform baseline plus the caller's own types
  app.get('/api/events/types', async (req: FastifyRequest, reply: FastifyReply) => {
    try {
      const tenant_id = req.auth?.tenant_id ?? null;
      const { platform, tenant } = await listEventTypes(tenant_id);
      reply.code(200).send({
        data: {
          // Unchanged shape for existing consumers: `count`/`types` still mean
          // "everything you may emit", now including this tenant's own types.
          count: platform.length + tenant.length,
          types: [...platform, ...tenant],
          platform_count: platform.length,
          tenant_count: tenant.length,
        },
      });
    } catch (err) {
      req.log.error(err);
      if (!reply.sent) reply.code(500).send({ error: 'InternalError' });
    }
  });

  // POST /api/events/types — register an event type for the caller's tenant
  app.post('/api/events/types', async (req: FastifyRequest, reply: FastifyReply) => {
    try {
      // The tenant comes from the VERIFIED CLAIM, never from the body. Reading
      // it from the payload would let any signed-in user of tenant A define
      // vocabulary inside tenant B.
      const tenant_id = req.auth?.tenant_id ?? null;
      if (!tenant_id) {
        reply.code(400).send({
          error: 'ValidationError',
          details: ['a tenant-scoped token is required to register an event type'],
        });
        return;
      }

      const body = (req.body ?? {}) as Partial<RegisterEventTypeInput>;
      const result = await registerTenantEventType({
        tenant_id,
        event_type: typeof body.event_type === 'string' ? body.event_type.trim() : '',
        retention_class: body.retention_class as RegisterEventTypeInput['retention_class'],
        conflict_policy: body.conflict_policy as RegisterEventTypeInput['conflict_policy'],
        schema_state: body.schema_state,
        compaction_policy: body.compaction_policy,
        schema_version: body.schema_version,
        registered_by: req.auth?.sub ?? null,
      });

      // 200 rather than 201 on a repeat: registration is additive, so the second
      // call did not create anything. A boot-time provisioner re-running on
      // every deploy is the expected caller, and it must not read as an error.
      reply.code(result.created ? 201 : 200).send({
        data: { ...result.meta, created: result.created, source: 'tenant' },
      });
    } catch (err) {
      if (err instanceof EventTypeRegistrationError) {
        reply.code(400).send({ error: 'ValidationError', details: err.errors });
        return;
      }
      req.log.error(err);
      if (!reply.sent) reply.code(500).send({ error: 'InternalError' });
    }
  });

  // GET /api/events/types/:type — lookup one type, baseline first
  app.get('/api/events/types/:type', async (req: FastifyRequest<{ Params: { type: string } }>, reply: FastifyReply) => {
    try {
      const baseline = EVENT_TYPE_REGISTRY[req.params.type];
      if (baseline) {
        reply.code(200).send({ data: { ...baseline, source: 'platform' } });
        return;
      }

      const tenant_id = req.auth?.tenant_id ?? null;
      if (tenant_id) {
        const { tenant } = await listEventTypes(tenant_id);
        const own = tenant.find((t) => t.event_type === req.params.type);
        if (own) {
          reply.code(200).send({ data: { ...own, source: 'tenant' } });
          return;
        }
      }

      reply.code(404).send({
        error: 'UnregisteredEventType',
        details: [
          `event_type '${req.params.type}' is not registered. ` +
            'Register it for this tenant with POST /api/events/types.',
        ],
      });
    } catch (err) {
      req.log.error(err);
      if (!reply.sent) reply.code(500).send({ error: 'InternalError' });
    }
  });
}
