import { FastifyInstance } from 'fastify';
import { requireAuth } from '@projexlight/sdk-identity';
import {
  assignRole,
  createAppIdentity,
  createMembership,
  createPersona,
  getAppIdentity,
  getPersona,
  listAppIdentitiesForPerson,
  listMembershipsForAppIdentity,
  listPersonasForMembership,
  listRoleHolders,
  listRolesForPersona,
  revokeRoleAssignment,
  shredPersona,
  terminateMembership,
} from '../services/personaService';

export async function registerRoutes(app: FastifyInstance): Promise<void> {
  // ----- App Identity (L2) -----
  app.post('/api/app-identities', { preHandler: requireAuth }, async (req, reply) => {
    const body = req.body as Partial<{ person_id: string; app_id: string }>;
    if (!body.person_id || !body.app_id) {
      return reply.code(400).send({ error: 'ValidationError', details: ['missing fields'] });
    }
    const record = await createAppIdentity({ person_id: body.person_id, app_id: body.app_id });
    return reply.code(201).send({ data: { app_identity: record } });
  });

  app.get<{ Params: { app_identity_id: string } }>(
    '/api/app-identities/:app_identity_id',
    { preHandler: requireAuth },
    async (req, reply) => {
      const record = await getAppIdentity(req.params.app_identity_id);
      if (!record) return reply.code(404).send({ error: 'NotFound' });
      return reply.code(200).send({ data: { app_identity: record } });
    },
  );

  app.get<{ Params: { person_id: string } }>(
    '/api/persons/:person_id/app-identities',
    { preHandler: requireAuth },
    async (req, reply) => {
      const records = await listAppIdentitiesForPerson(req.params.person_id);
      return reply.code(200).send({ data: { app_identities: records } });
    },
  );

  // ----- Membership (L3) -----
  app.post('/api/memberships', { preHandler: requireAuth }, async (req, reply) => {
    const body = req.body as Partial<{ app_identity_id: string; tenant_id: string }>;
    if (!body.app_identity_id || !body.tenant_id) {
      return reply.code(400).send({ error: 'ValidationError', details: ['missing fields'] });
    }
    const record = await createMembership({
      app_identity_id: body.app_identity_id,
      tenant_id: body.tenant_id,
    });
    return reply.code(201).send({ data: { membership: record } });
  });

  app.get<{ Params: { app_identity_id: string } }>(
    '/api/app-identities/:app_identity_id/memberships',
    { preHandler: requireAuth },
    async (req, reply) => {
      const records = await listMembershipsForAppIdentity(req.params.app_identity_id);
      return reply.code(200).send({ data: { memberships: records } });
    },
  );

  app.post<{ Params: { membership_id: string } }>(
    '/api/memberships/:membership_id/terminate',
    { preHandler: requireAuth },
    async (req, reply) => {
      const record = await terminateMembership(req.params.membership_id);
      if (!record) return reply.code(404).send({ error: 'NotFound' });
      return reply.code(200).send({ data: { membership: record } });
    },
  );

  // ----- Persona (L4) -----
  app.post('/api/personas', { preHandler: requireAuth }, async (req, reply) => {
    const body = req.body as Partial<{
      membership_id: string;
      kind: string;
      primary_role_template_id: string;
      bu_id: string;
      persona_key_ref: string;
    }>;
    if (!body.membership_id || !body.kind) {
      return reply.code(400).send({ error: 'ValidationError', details: ['missing fields'] });
    }
    const record = await createPersona({
      membership_id: body.membership_id,
      kind: body.kind,
      primary_role_template_id: body.primary_role_template_id,
      bu_id: body.bu_id,
      persona_key_ref: body.persona_key_ref,
    });
    return reply.code(201).send({ data: { persona: record } });
  });

  app.get<{ Params: { persona_id: string } }>(
    '/api/personas/:persona_id',
    { preHandler: requireAuth },
    async (req, reply) => {
      const record = await getPersona(req.params.persona_id);
      if (!record) return reply.code(404).send({ error: 'NotFound' });
      return reply.code(200).send({ data: { persona: record } });
    },
  );

  app.get<{ Params: { membership_id: string } }>(
    '/api/memberships/:membership_id/personas',
    { preHandler: requireAuth },
    async (req, reply) => {
      const records = await listPersonasForMembership(req.params.membership_id);
      return reply.code(200).send({ data: { personas: records } });
    },
  );

  app.post<{ Params: { persona_id: string } }>(
    '/api/personas/:persona_id/shred',
    { preHandler: requireAuth },
    async (req, reply) => {
      const record = await shredPersona(req.params.persona_id);
      if (!record) return reply.code(404).send({ error: 'NotFound' });
      return reply.code(200).send({ data: { persona: record } });
    },
  );

  // ----- Role assignment -----
  app.post('/api/role-assignments', { preHandler: requireAuth }, async (req, reply) => {
    const body = req.body as Partial<{
      persona_id: string;
      role_template_id: string;
      assigned_by: string;
    }>;
    if (!body.persona_id || !body.role_template_id) {
      return reply.code(400).send({ error: 'ValidationError', details: ['missing fields'] });
    }
    const record = await assignRole({
      persona_id: body.persona_id,
      role_template_id: body.role_template_id,
      assigned_by: body.assigned_by,
    });
    return reply.code(201).send({ data: { assignment: record } });
  });

  app.post<{ Params: { assignment_id: string } }>(
    '/api/role-assignments/:assignment_id/revoke',
    { preHandler: requireAuth },
    async (req, reply) => {
      const record = await revokeRoleAssignment(req.params.assignment_id);
      if (!record) return reply.code(404).send({ error: 'NotFound' });
      return reply.code(200).send({ data: { assignment: record } });
    },
  );

  app.get<{ Params: { persona_id: string } }>(
    '/api/personas/:persona_id/roles',
    { preHandler: requireAuth },
    async (req, reply) => {
      const records = await listRolesForPersona(req.params.persona_id);
      return reply.code(200).send({ data: { roles: records } });
    },
  );

  /*
   * The reverse of the route above: who holds this role?
   *
   * tenant_id is a REQUIRED query param and the 400 is deliberate. The holder set
   * is assembled by joining through persona.membership, which is where the tenant
   * lives — persona.role_assignment carries no tenant column of its own. Defaulting
   * the parameter to "all tenants" would hand any authenticated caller every
   * tenant's role holders, so the endpoint refuses rather than guesses.
   *
   * Returns each persona once even when it holds the role both ways; see
   * listRoleHolders for why that matters to a caller fanning out a notification.
   */
  app.get<{
    Params: { role_template_id: string };
    Querystring: { tenant_id?: string; include_primary?: string; limit?: string };
  }>(
    '/api/role-templates/:role_template_id/holders',
    { preHandler: requireAuth },
    async (req, reply) => {
      const q = req.query;
      if (!q.tenant_id) {
        return reply.code(400).send({
          error: 'ValidationError',
          details: ['tenant_id query param required'],
        });
      }
      // Only the literal 'false' turns primary-role holders off. Treating any
      // non-empty value as false would make ?include_primary=true exclude them.
      const include_primary = q.include_primary !== 'false';
      const holders = await listRoleHolders({
        role_template_id: req.params.role_template_id,
        tenant_id: q.tenant_id,
        include_primary,
        limit: q.limit ? Number(q.limit) : undefined,
      });
      return reply.code(200).send({
        data: {
          holders,
          role_template_id: req.params.role_template_id,
          tenant_id: q.tenant_id,
          include_primary,
          count: holders.length,
        },
      });
    },
  );
}
