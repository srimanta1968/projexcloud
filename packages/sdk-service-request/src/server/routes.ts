import { FastifyInstance } from 'fastify';
import { requireAuth } from '@projexlight/sdk-identity';
import {
  assignTicket,
  createQueue,
  createTicket,
  getTicket,
  transitionTicket,
} from '../services/srService';
import type { TicketPriority, TicketSeverity, TicketStatus } from '../models/ticket.model';

const STATUSES: TicketStatus[] = ['new', 'in-progress', 'awaiting-customer', 'resolved', 'closed'];

export async function registerRoutes(app: FastifyInstance): Promise<void> {
  app.post('/api/service-request/tickets', { preHandler: requireAuth }, async (req, reply) => {
    const body = req.body as Partial<{
      tenant_id: string;
      encounter_id: string;
      requester_persona_id: string;
      queue_id: string;
      priority: TicketPriority;
      severity: TicketSeverity;
      external_refs: Record<string, string>;
    }>;
    if (!body.tenant_id || !body.encounter_id || !body.requester_persona_id) {
      return reply.code(400).send({ error: 'ValidationError', details: ['missing fields'] });
    }
    const rec = await createTicket({
      tenant_id: body.tenant_id,
      encounter_id: body.encounter_id,
      requester_persona_id: body.requester_persona_id,
      queue_id: body.queue_id,
      priority: body.priority,
      severity: body.severity,
      external_refs: body.external_refs,
    });
    return reply.code(201).send({ data: { ticket: rec } });
  });

  app.get<{ Params: { ticket_id: string } }>(
    '/api/service-request/tickets/:ticket_id',
    { preHandler: requireAuth },
    async (req, reply) => {
      const rec = await getTicket(req.params.ticket_id);
      if (!rec) return reply.code(404).send({ error: 'NotFound' });
      return reply.code(200).send({ data: { ticket: rec } });
    },
  );

  app.post<{ Params: { ticket_id: string } }>(
    '/api/service-request/tickets/:ticket_id/assign',
    { preHandler: requireAuth },
    async (req, reply) => {
      const body = req.body as Partial<{ assignee_persona_id: string }>;
      if (!body.assignee_persona_id) {
        return reply.code(400).send({ error: 'ValidationError', details: ['missing assignee_persona_id'] });
      }
      const rec = await assignTicket(req.params.ticket_id, body.assignee_persona_id);
      if (!rec) return reply.code(404).send({ error: 'NotFound' });
      return reply.code(200).send({ data: { ticket: rec } });
    },
  );

  app.post<{ Params: { ticket_id: string } }>(
    '/api/service-request/tickets/:ticket_id/transition',
    { preHandler: requireAuth },
    async (req, reply) => {
      const body = req.body as Partial<{ to: TicketStatus }>;
      if (!body.to || !STATUSES.includes(body.to)) {
        return reply.code(400).send({ error: 'ValidationError', details: ['invalid target status'] });
      }
      try {
        const rec = await transitionTicket(req.params.ticket_id, body.to);
        if (!rec) return reply.code(404).send({ error: 'NotFound' });
        return reply.code(200).send({ data: { ticket: rec } });
      } catch (err) {
        return reply.code(409).send({ error: 'InvalidTransition', details: [(err as Error).message] });
      }
    },
  );

  app.post('/api/service-request/queues', { preHandler: requireAuth }, async (req, reply) => {
    const body = req.body as Partial<{ tenant_id: string; name: string; priority: number }>;
    if (!body.tenant_id || !body.name) {
      return reply.code(400).send({ error: 'ValidationError', details: ['missing fields'] });
    }
    const rec = await createQueue(body.tenant_id, body.name, body.priority);
    return reply.code(201).send({ data: { queue: rec } });
  });
}
