import { FastifyInstance } from 'fastify';
import { requireAuth } from '@projexlight/sdk-identity';
import {
  createIncident,
  findSlaBreaches,
  getIncident,
  listIncidents,
  transitionIncident,
  updateIncident,
  InvalidIncidentTransition,
} from '../services/incidentService';
import type { CreateIncidentInput, IncidentStatus, UpdateIncidentInput } from '../models/incident.model';

const STATUSES: IncidentStatus[] = ['open', 'investigating', 'mitigated', 'resolved', 'closed', 'cancelled'];

/**
 * HTTP surface for sdk-incident (P15·E3). Incident CRUD, the status-lifecycle
 * transition endpoint, and the tenant-scoped SLA-breach scan. Every call
 * requires auth and is tenant-scoped.
 */
export async function registerRoutes(app: FastifyInstance): Promise<void> {
  app.post('/api/incidents', { preHandler: requireAuth }, async (req, reply) => {
    const body = (req.body ?? {}) as Partial<CreateIncidentInput>;
    if (!body.tenant_id || !body.incident_type || !body.title) {
      return reply.code(400).send({ error: 'ValidationError', details: ['tenant_id, incident_type and title are required'] });
    }
    const rec = await createIncident(body as CreateIncidentInput);
    return reply.code(201).send({ data: { incident: rec } });
  });

  // Static path registered before ':incident_id' for clarity (Fastify's radix
  // router already prioritises static segments over params).
  app.get<{ Querystring: { tenant_id?: string; limit?: string } }>(
    '/api/incidents/sla-breaches', { preHandler: requireAuth }, async (req, reply) => {
      if (!req.query.tenant_id) return reply.code(400).send({ error: 'ValidationError', details: ['tenant_id query param required'] });
      const incidents = await findSlaBreaches(req.query.tenant_id, {
        limit: req.query.limit ? Number(req.query.limit) : undefined,
      });
      return reply.code(200).send({ data: { incidents } });
    },
  );

  app.get<{ Querystring: { tenant_id?: string; status?: string; severity?: string; owner_persona_id?: string; limit?: string; offset?: string } }>(
    '/api/incidents', { preHandler: requireAuth }, async (req, reply) => {
      if (!req.query.tenant_id) return reply.code(400).send({ error: 'ValidationError', details: ['tenant_id query param required'] });
      const incidents = await listIncidents(req.query.tenant_id, {
        status: req.query.status,
        severity: req.query.severity,
        owner_persona_id: req.query.owner_persona_id,
        limit: req.query.limit ? Number(req.query.limit) : undefined,
        offset: req.query.offset ? Number(req.query.offset) : undefined,
      });
      return reply.code(200).send({ data: { incidents } });
    },
  );

  app.get<{ Params: { incident_id: string }; Querystring: { tenant_id?: string } }>(
    '/api/incidents/:incident_id', { preHandler: requireAuth }, async (req, reply) => {
      if (!req.query.tenant_id) return reply.code(400).send({ error: 'ValidationError', details: ['tenant_id query param required'] });
      const rec = await getIncident(req.query.tenant_id, req.params.incident_id);
      if (!rec) return reply.code(404).send({ error: 'NotFound' });
      return reply.code(200).send({ data: { incident: rec } });
    },
  );

  app.patch<{ Params: { incident_id: string } }>(
    '/api/incidents/:incident_id', { preHandler: requireAuth }, async (req, reply) => {
      const body = (req.body ?? {}) as { tenant_id?: string } & UpdateIncidentInput;
      if (!body.tenant_id) return reply.code(400).send({ error: 'ValidationError', details: ['tenant_id is required'] });
      const rec = await updateIncident(body.tenant_id, req.params.incident_id, body);
      if (!rec) return reply.code(404).send({ error: 'NotFound' });
      return reply.code(200).send({ data: { incident: rec } });
    },
  );

  app.post<{ Params: { incident_id: string } }>(
    '/api/incidents/:incident_id/transition', { preHandler: requireAuth }, async (req, reply) => {
      const body = (req.body ?? {}) as { tenant_id?: string; status?: IncidentStatus };
      if (!body.tenant_id || !body.status) {
        return reply.code(400).send({ error: 'ValidationError', details: ['tenant_id and status are required'] });
      }
      if (!STATUSES.includes(body.status)) {
        return reply.code(400).send({ error: 'ValidationError', details: ['invalid status'] });
      }
      try {
        const rec = await transitionIncident(body.tenant_id, req.params.incident_id, body.status);
        if (!rec) return reply.code(404).send({ error: 'NotFound' });
        return reply.code(200).send({ data: { incident: rec } });
      } catch (err) {
        if (err instanceof InvalidIncidentTransition) {
          return reply.code(409).send({ error: 'InvalidTransition', message: err.message });
        }
        throw err;
      }
    },
  );
}
