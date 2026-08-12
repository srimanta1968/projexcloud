import { FastifyReply, FastifyRequest } from 'fastify';
import {
  attachReseller,
  createBu,
  createGeoNode,
  createReseller,
  createRoleTemplate,
  createSubTenant,
  createTenant,
  getTenant,
  setFiscalCalendar,
} from '../../services/tenantService';
import {
  validateAttachReseller,
  validateCreateBu,
  validateCreateGeoNode,
  validateCreateReseller,
  validateCreateRoleTemplate,
  validateCreateSubTenant,
  validateCreateTenant,
  validateSetFiscalCalendar,
} from '../../validators/tenantValidator';

/**
 * TWO ID SPACES CALLED "APP", AND THE FK VIOLATION DOES NOT SAY SO.
 *
 * tenant.role_template.app_id is a TEXT slug FK'd to tenant.app — the PRODUCT
 * app, created by POST /api/auth/signup-tenant or POST /admin/apps. It is not the
 * UUID that POST /api/applications hands back; that id belongs to
 * api_keys.application, a CREDENTIAL HOLDER, and several of them per product app
 * is the normal shape (live/test, one key per consumer).
 *
 * A caller that reads the UUID as "the application id" and keys role templates on
 * it gets `role_template_app_id_fkey` and a raw Postgres string, which names
 * neither space and reads as a platform fault. This has cost a consumer a
 * debugging session; the constraint name is the one signal that identifies the
 * confusion, so it is worth spending on a message that resolves it.
 */
function foreignKeyDetail(msg: string): string {
  if (msg.includes('role_template_app_id_fkey')) {
    return (
      'app_id must be a tenant.app slug (e.g. "acme-inc-304d62"), as returned by ' +
      'POST /api/auth/signup-tenant or POST /admin/apps. It is NOT the application_id ' +
      'UUID returned by POST /api/applications — that id belongs to api_keys.application, ' +
      'which is a credential holder rather than a product app, and no tenant.app row exists ' +
      `for it. Original: ${msg}`
    );
  }
  return msg;
}

function uncaught(req: FastifyRequest, reply: FastifyReply, err: unknown): void {
  const msg = (err as Error).message;
  if (msg.includes('violates foreign key')) {
    reply.code(400).send({ error: 'ValidationError', details: [foreignKeyDetail(msg)] });
    return;
  }
  if (msg.includes('duplicate key')) {
    reply.code(409).send({ error: 'Conflict', details: [msg] });
    return;
  }
  if (msg.includes('not found')) {
    reply.code(404).send({ error: 'NotFound', details: [msg] });
    return;
  }
  req.log.error(err);
  reply.code(500).send({ error: 'InternalError' });
}

export async function createTenantHandler(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const v = validateCreateTenant(req.body);
  if (!v.ok) return void reply.code(400).send({ error: 'ValidationError', details: v.errors });
  try {
    const tenant = await createTenant(v.value);
    reply.code(201).send({ data: tenant });
  } catch (err) { uncaught(req, reply, err); }
}

export async function getTenantHandler(
  req: FastifyRequest<{ Params: { tenant_id: string } }>,
  reply: FastifyReply,
): Promise<void> {
  try {
    const tenant = await getTenant(req.params.tenant_id);
    if (!tenant) {
      reply.code(404).send({ error: 'NotFound', details: [`No tenant with id ${req.params.tenant_id}`] });
      return;
    }
    reply.code(200).send({ data: tenant });
  } catch (err) { uncaught(req, reply, err); }
}

export async function createResellerHandler(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const v = validateCreateReseller(req.body);
  if (!v.ok) return void reply.code(400).send({ error: 'ValidationError', details: v.errors });
  try {
    const reseller = await createReseller(v.value);
    reply.code(201).send({ data: { reseller } });
  } catch (err) { uncaught(req, reply, err); }
}

export async function attachResellerHandler(
  req: FastifyRequest<{ Params: { tenant_id: string } }>,
  reply: FastifyReply,
): Promise<void> {
  const v = validateAttachReseller(req.body);
  if (!v.ok) return void reply.code(400).send({ error: 'ValidationError', details: v.errors });
  try {
    const tenant = await attachReseller(req.params.tenant_id, v.value.reseller_id, {
      commission_rules: v.value.commission_rules,
    });
    reply.code(200).send({ data: tenant });
  } catch (err) { uncaught(req, reply, err); }
}

export async function createSubTenantHandler(
  req: FastifyRequest<{ Params: { tenant_id: string } }>,
  reply: FastifyReply,
): Promise<void> {
  const v = validateCreateSubTenant(req.body);
  if (!v.ok) return void reply.code(400).send({ error: 'ValidationError', details: v.errors });
  try {
    const tenant = await createSubTenant(req.params.tenant_id, v.value, { placement: v.value.placement });
    reply.code(201).send({ data: tenant });
  } catch (err) { uncaught(req, reply, err); }
}

export async function createBuHandler(
  req: FastifyRequest<{ Params: { tenant_id: string } }>,
  reply: FastifyReply,
): Promise<void> {
  const v = validateCreateBu(req.body);
  if (!v.ok) return void reply.code(400).send({ error: 'ValidationError', details: v.errors });
  try {
    const bu = await createBu(req.params.tenant_id, v.value);
    reply.code(201).send({ data: { bu } });
  } catch (err) { uncaught(req, reply, err); }
}

export async function createGeoNodeHandler(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const v = validateCreateGeoNode(req.body);
  if (!v.ok) return void reply.code(400).send({ error: 'ValidationError', details: v.errors });
  try {
    const geo_node = await createGeoNode(v.value);
    reply.code(201).send({ data: { geo_node } });
  } catch (err) { uncaught(req, reply, err); }
}

export async function createRoleTemplateHandler(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const v = validateCreateRoleTemplate(req.body);
  if (!v.ok) return void reply.code(400).send({ error: 'ValidationError', details: v.errors });
  try {
    const role_template = await createRoleTemplate(v.value);
    reply.code(201).send({ data: { role_template } });
  } catch (err) { uncaught(req, reply, err); }
}

export async function setFiscalCalendarHandler(
  req: FastifyRequest<{ Params: { tenant_id: string } }>,
  reply: FastifyReply,
): Promise<void> {
  const v = validateSetFiscalCalendar(req.body);
  if (!v.ok) return void reply.code(400).send({ error: 'ValidationError', details: v.errors });
  try {
    const periods = await setFiscalCalendar(req.params.tenant_id, v.value);
    reply.code(201).send({ data: { periods } });
  } catch (err) { uncaught(req, reply, err); }
}
