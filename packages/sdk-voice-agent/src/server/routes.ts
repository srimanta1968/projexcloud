import type { FastifyInstance } from 'fastify';
import { requireAuth } from '@projexlight/sdk-identity';
import { VOICE_PRESETS } from '../models/presets';
import {
  archiveStackProfile,
  createStackProfile,
  getStackProfile,
  listStackProfiles,
  updateStackProfile,
  type CreateStackProfileInput,
  type UpdateStackProfileInput,
} from '../services/stackProfileService';
import { resolveTenant } from './tenantScope';
import { registerAgentRoutes } from './agentRoutes';
import { registerToolRoutes } from './toolRoutes';
import { sendError } from './sendError';

/**
 * HTTP surface for sdk-voice-agent (VA·E2). Every route requires a tenant credential
 * and is scoped to the authenticated tenant (see tenantScope.resolveTenant).
 */
export async function registerRoutes(app: FastifyInstance): Promise<void> {
  // TK-4469 — preset catalogue.
  app.get('/api/voice-agent/presets', { preHandler: requireAuth }, async (_req, reply) => {
    return reply.code(200).send({ data: { presets: VOICE_PRESETS } });
  });

  registerAgentRoutes(app);
  registerToolRoutes(app);

  // TK-4469 — stack profiles.
  app.post('/api/voice-agent/stack-profiles', { preHandler: requireAuth }, async (req, reply) => {
    const body = (req.body ?? {}) as Partial<CreateStackProfileInput> & { tenant_id?: string };
    const tenantId = resolveTenant(req, reply, body.tenant_id);
    if (!tenantId) return reply;
    try {
      const stackProfile = await createStackProfile(tenantId, body as CreateStackProfileInput);
      return reply.code(201).send({ data: { stack_profile: stackProfile } });
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.get<{ Querystring: { tenant_id?: string; status?: string; limit?: string; offset?: string } }>(
    '/api/voice-agent/stack-profiles', { preHandler: requireAuth }, async (req, reply) => {
      const tenantId = resolveTenant(req, reply, req.query.tenant_id);
      if (!tenantId) return reply;
      try {
        const page = await listStackProfiles(tenantId, {
          status: req.query.status,
          limit: req.query.limit ? Number(req.query.limit) : undefined,
          offset: req.query.offset ? Number(req.query.offset) : undefined,
        });
        return reply.code(200).send({ data: page });
      } catch (err) {
        return sendError(reply, err);
      }
    },
  );

  app.get<{ Params: { profile_id: string }; Querystring: { tenant_id?: string } }>(
    '/api/voice-agent/stack-profiles/:profile_id', { preHandler: requireAuth }, async (req, reply) => {
      const tenantId = resolveTenant(req, reply, req.query.tenant_id);
      if (!tenantId) return reply;
      const stackProfile = await getStackProfile(tenantId, req.params.profile_id);
      if (!stackProfile) return reply.code(404).send({ error: 'NotFound', details: ['stack profile not found'] });
      return reply.code(200).send({ data: { stack_profile: stackProfile } });
    },
  );

  app.patch<{ Params: { profile_id: string } }>(
    '/api/voice-agent/stack-profiles/:profile_id', { preHandler: requireAuth }, async (req, reply) => {
      const body = (req.body ?? {}) as UpdateStackProfileInput & { tenant_id?: string; preset_key?: unknown };
      const tenantId = resolveTenant(req, reply, body.tenant_id);
      if (!tenantId) return reply;
      try {
        const stackProfile = await updateStackProfile(tenantId, req.params.profile_id, body);
        return reply.code(200).send({ data: { stack_profile: stackProfile } });
      } catch (err) {
        return sendError(reply, err);
      }
    },
  );

  app.delete<{ Params: { profile_id: string }; Querystring: { tenant_id?: string } }>(
    '/api/voice-agent/stack-profiles/:profile_id', { preHandler: requireAuth }, async (req, reply) => {
      const tenantId = resolveTenant(req, reply, req.query.tenant_id);
      if (!tenantId) return reply;
      const found = await archiveStackProfile(tenantId, req.params.profile_id);
      if (!found) return reply.code(404).send({ error: 'NotFound', details: ['stack profile not found'] });
      return reply.code(204).send();
    },
  );
}
