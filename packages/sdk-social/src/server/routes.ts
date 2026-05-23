import { FastifyInstance } from 'fastify';
import { requireAuth } from '@projexlight/sdk-identity';
import { authorizeHandle, captureLead, ingestInteraction } from '../services/socialService';
import type { InteractionKind, SocialNetwork } from '../models/social.model';

const NETWORKS: SocialNetwork[] = ['twitter', 'linkedin', 'instagram', 'facebook', 'tiktok'];
const KINDS: InteractionKind[] = ['dm', 'comment', 'mention', 'review'];

export async function registerRoutes(app: FastifyInstance): Promise<void> {
  app.post('/api/social/handles', { preHandler: requireAuth }, async (req, reply) => {
    const body = req.body as Partial<{
      tenant_id: string;
      network: SocialNetwork;
      external_handle_id: string;
      authorized_persona_id: string;
    }>;
    if (!body.tenant_id || !body.network || !body.external_handle_id || !body.authorized_persona_id) {
      return reply.code(400).send({ error: 'ValidationError', details: ['missing fields'] });
    }
    if (!NETWORKS.includes(body.network)) {
      return reply.code(400).send({ error: 'ValidationError', details: ['invalid network'] });
    }
    const rec = await authorizeHandle({
      tenant_id: body.tenant_id,
      network: body.network,
      external_handle_id: body.external_handle_id,
      authorized_persona_id: body.authorized_persona_id,
    });
    return reply.code(201).send({ data: { handle: rec } });
  });

  app.post('/api/social/interactions', { preHandler: requireAuth }, async (req, reply) => {
    const body = req.body as Partial<{
      handle_id: string;
      kind: InteractionKind;
      author_external_id: string;
      author_persona_id: string;
      body: string;
    }>;
    if (!body.handle_id || !body.kind || !body.author_external_id) {
      return reply.code(400).send({ error: 'ValidationError', details: ['missing fields'] });
    }
    if (!KINDS.includes(body.kind)) {
      return reply.code(400).send({ error: 'ValidationError', details: ['invalid kind'] });
    }
    const rec = await ingestInteraction({
      handle_id: body.handle_id,
      kind: body.kind,
      author_external_id: body.author_external_id,
      author_persona_id: body.author_persona_id,
      body: body.body,
    });
    return reply.code(201).send({ data: { interaction: rec } });
  });

  app.post<{ Params: { interaction_id: string } }>(
    '/api/social/interactions/:interaction_id/capture-lead',
    { preHandler: requireAuth },
    async (req, reply) => {
      const body = req.body as Partial<{ contact_id: string }>;
      if (!body.contact_id) {
        return reply.code(400).send({ error: 'ValidationError', details: ['missing contact_id'] });
      }
      const rec = await captureLead(req.params.interaction_id, body.contact_id);
      if (!rec) return reply.code(404).send({ error: 'NotFound' });
      return reply.code(200).send({ data: { interaction: rec } });
    },
  );
}
