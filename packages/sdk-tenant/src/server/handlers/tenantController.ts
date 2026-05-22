import { FastifyReply, FastifyRequest } from 'fastify';
import { createTenant, getTenant } from '../../services/tenantService';
import { validateCreateTenant } from '../../validators/tenantValidator';

/**
 * POST /api/tenants — creates a tenant. The DB trigger materializes
 * root_tenant_id from the parent chain.
 */
export async function createTenantHandler(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const validation = validateCreateTenant(req.body);
  if (!validation.ok) {
    reply.code(400).send({ error: 'ValidationError', details: validation.errors });
    return;
  }
  try {
    const tenant = await createTenant(validation.value);
    reply.code(201).send({ data: tenant });
  } catch (err) {
    const msg = (err as Error).message;
    if (msg.includes('violates foreign key')) {
      reply.code(400).send({ error: 'ValidationError', details: [msg] });
      return;
    }
    req.log.error(err);
    reply.code(500).send({ error: 'InternalError' });
  }
}

/**
 * GET /api/tenants/:tenant_id — returns the tenant record.
 */
export async function getTenantHandler(req: FastifyRequest<{ Params: { tenant_id: string } }>, reply: FastifyReply): Promise<void> {
  try {
    const tenant = await getTenant(req.params.tenant_id);
    if (!tenant) {
      reply.code(404).send({ error: 'NotFound', details: [`No tenant with id ${req.params.tenant_id}`] });
      return;
    }
    reply.code(200).send({ data: tenant });
  } catch (err) {
    req.log.error(err);
    reply.code(500).send({ error: 'InternalError' });
  }
}
