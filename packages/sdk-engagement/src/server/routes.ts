import { FastifyInstance } from 'fastify';
import { requireAuth } from '@projexlight/sdk-identity';
import {
  addParticipant,
  checkGrant,
  getEncounter,
  issueGrant,
  listActiveGrants,
  listParticipants,
  openEncounter,
  removeParticipant,
  revokeGrant,
  transitionEncounter,
} from '../services/engagementService';
import type { EncounterState } from '../models/engagement.model';

const STATES: EncounterState[] = ['open', 'in-progress', 'closed', 'sealed'];

export async function registerRoutes(app: FastifyInstance): Promise<void> {
  // Encounters --------------------------------------------------------
  app.post('/api/encounters', { preHandler: requireAuth }, async (req, reply) => {
    const body = req.body as Partial<{
      tenant_id: string;
      kind: string;
      retention_policy: string;
      parent_encounter_id: string;
      address_id: string;
      billing_ref: string;
      parent_key_id: string;
      region: string;
    }>;
    if (!body.tenant_id || !body.kind || !body.parent_key_id || !body.region) {
      return reply.code(400).send({ error: 'ValidationError', details: ['missing fields'] });
    }
    const encounter = await openEncounter({
      tenant_id: body.tenant_id,
      kind: body.kind,
      retention_policy: body.retention_policy,
      parent_encounter_id: body.parent_encounter_id,
      address_id: body.address_id,
      billing_ref: body.billing_ref,
      parent_key_id: body.parent_key_id,
      region: body.region,
    });
    return reply.code(201).send({ data: { encounter } });
  });

  app.get<{ Params: { encounter_id: string } }>(
    '/api/encounters/:encounter_id',
    { preHandler: requireAuth },
    async (req, reply) => {
      const rec = await getEncounter(req.params.encounter_id);
      if (!rec) return reply.code(404).send({ error: 'NotFound' });
      return reply.code(200).send({ data: { encounter: rec } });
    },
  );

  app.post<{ Params: { encounter_id: string } }>(
    '/api/encounters/:encounter_id/transition',
    { preHandler: requireAuth },
    async (req, reply) => {
      const body = req.body as Partial<{ to: EncounterState; actor_id: string }>;
      if (!body.to || !STATES.includes(body.to)) {
        return reply.code(400).send({ error: 'ValidationError', details: ['invalid target state'] });
      }
      try {
        const rec = await transitionEncounter(req.params.encounter_id, body.to, body.actor_id);
        return reply.code(200).send({ data: { encounter: rec } });
      } catch (err) {
        return reply.code(409).send({ error: 'InvalidTransition', details: [(err as Error).message] });
      }
    },
  );

  // Participants ------------------------------------------------------
  app.post<{ Params: { encounter_id: string } }>(
    '/api/encounters/:encounter_id/participants',
    { preHandler: requireAuth },
    async (req, reply) => {
      const body = req.body as Partial<{ persona_id: string; role: string; required: boolean }>;
      if (!body.persona_id || !body.role) {
        return reply.code(400).send({ error: 'ValidationError', details: ['missing fields'] });
      }
      const rec = await addParticipant({
        encounter_id: req.params.encounter_id,
        persona_id: body.persona_id,
        role: body.role,
        required: body.required,
      });
      return reply.code(201).send({ data: { participant: rec } });
    },
  );

  app.get<{ Params: { encounter_id: string } }>(
    '/api/encounters/:encounter_id/participants',
    { preHandler: requireAuth },
    async (req, reply) => {
      const rows = await listParticipants(req.params.encounter_id);
      return reply.code(200).send({ data: { participants: rows } });
    },
  );

  app.post<{ Params: { participant_id: string } }>(
    '/api/participants/:participant_id/leave',
    { preHandler: requireAuth },
    async (req, reply) => {
      const rec = await removeParticipant(req.params.participant_id);
      if (!rec) return reply.code(404).send({ error: 'NotFound' });
      return reply.code(200).send({ data: { participant: rec } });
    },
  );

  // Grants ------------------------------------------------------------
  app.post<{ Params: { encounter_id: string } }>(
    '/api/encounters/:encounter_id/grants',
    { preHandler: requireAuth },
    async (req, reply) => {
      const body = req.body as Partial<{
        grantee_persona_id: string;
        issuer_persona_id: string;
        scope: Record<string, unknown>;
        ttl_ms: number;
        capability_token_ref: string;
      }>;
      if (!body.grantee_persona_id || !body.issuer_persona_id || !body.scope || !body.ttl_ms) {
        return reply.code(400).send({ error: 'ValidationError', details: ['missing fields'] });
      }
      const grant = await issueGrant({
        encounter_id: req.params.encounter_id,
        grantee_persona_id: body.grantee_persona_id,
        issuer_persona_id: body.issuer_persona_id,
        scope: body.scope,
        ttl_ms: body.ttl_ms,
        capability_token_ref: body.capability_token_ref,
      });
      return reply.code(201).send({ data: { grant } });
    },
  );

  app.get<{ Params: { encounter_id: string } }>(
    '/api/encounters/:encounter_id/grants',
    { preHandler: requireAuth },
    async (req, reply) => {
      const grants = await listActiveGrants(req.params.encounter_id);
      return reply.code(200).send({ data: { grants } });
    },
  );

  app.post<{ Params: { grant_id: string } }>(
    '/api/grants/:grant_id/revoke',
    { preHandler: requireAuth },
    async (req, reply) => {
      const grant = await revokeGrant(req.params.grant_id);
      if (!grant) return reply.code(404).send({ error: 'NotFound' });
      return reply.code(200).send({ data: { grant } });
    },
  );

  app.post<{ Params: { encounter_id: string } }>(
    '/api/encounters/:encounter_id/grants/check',
    { preHandler: requireAuth },
    async (req, reply) => {
      const body = req.body as Partial<{ grantee_persona_id: string; method: string }>;
      if (!body.grantee_persona_id || !body.method) {
        return reply.code(400).send({ error: 'ValidationError', details: ['missing fields'] });
      }
      const ok = await checkGrant(req.params.encounter_id, body.grantee_persona_id, body.method);
      return reply.code(200).send({ data: { allowed: ok } });
    },
  );
}
