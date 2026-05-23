import { FastifyInstance } from 'fastify';
import { requireAuth } from '@projexlight/sdk-identity';
import { checkIn, createSession, getSession, issueTicket } from '../services/eventService';

export async function registerRoutes(app: FastifyInstance): Promise<void> {
  app.post('/api/events/sessions', { preHandler: requireAuth }, async (req, reply) => {
    const body = req.body as Partial<{
      tenant_id: string;
      encounter_id: string;
      title: string;
      address_id: string;
      capacity: number;
      starts_at: string;
      ends_at: string;
    }>;
    if (!body.tenant_id || !body.encounter_id || !body.title || body.capacity == null || !body.starts_at || !body.ends_at) {
      return reply.code(400).send({ error: 'ValidationError', details: ['missing fields'] });
    }
    const rec = await createSession({
      tenant_id: body.tenant_id,
      encounter_id: body.encounter_id,
      title: body.title,
      address_id: body.address_id,
      capacity: body.capacity,
      starts_at: body.starts_at,
      ends_at: body.ends_at,
    });
    return reply.code(201).send({ data: { session: rec } });
  });

  app.get<{ Params: { session_id: string } }>(
    '/api/events/sessions/:session_id',
    { preHandler: requireAuth },
    async (req, reply) => {
      const rec = await getSession(req.params.session_id);
      if (!rec) return reply.code(404).send({ error: 'NotFound' });
      return reply.code(200).send({ data: { session: rec } });
    },
  );

  app.post('/api/events/tickets', { preHandler: requireAuth }, async (req, reply) => {
    const body = req.body as Partial<{ session_id: string; holder_persona_id: string; price: number }>;
    if (!body.session_id || !body.holder_persona_id) {
      return reply.code(400).send({ error: 'ValidationError', details: ['missing fields'] });
    }
    try {
      const rec = await issueTicket({
        session_id: body.session_id,
        holder_persona_id: body.holder_persona_id,
        price: body.price,
      });
      return reply.code(201).send({ data: { ticket: rec } });
    } catch (err) {
      return reply.code(409).send({ error: 'CannotIssueTicket', details: [(err as Error).message] });
    }
  });

  app.post('/api/events/checkin', { preHandler: requireAuth }, async (req, reply) => {
    const body = req.body as Partial<{ qr_token: string; device_uuid: string; checked_in_by_persona_id: string }>;
    if (!body.qr_token || !body.checked_in_by_persona_id) {
      return reply.code(400).send({ error: 'ValidationError', details: ['missing fields'] });
    }
    try {
      const rec = await checkIn({
        qr_token: body.qr_token,
        device_uuid: body.device_uuid,
        checked_in_by_persona_id: body.checked_in_by_persona_id,
      });
      return reply.code(201).send({ data: { checkin: rec } });
    } catch (err) {
      return reply.code(409).send({ error: 'CannotCheckIn', details: [(err as Error).message] });
    }
  });
}
