import { FastifyInstance } from 'fastify';
import { requireAuth } from '@projexlight/sdk-identity';
import {
  evaluate,
  getFlag,
  listFlags,
  setKillSwitch,
  upsertFlag,
  upsertRollout,
} from '../services/featureFlagsService';
import type { FlagKind } from '../models/flag.model';

const FLAG_KINDS: FlagKind[] = ['boolean', 'variant', 'numeric', 'json'];

export async function registerRoutes(app: FastifyInstance): Promise<void> {
  app.put('/api/flags', { preHandler: requireAuth }, async (req, reply) => {
    const body = req.body as Partial<{
      flag_id: string;
      description: string;
      kind: FlagKind;
      default_value: unknown;
      kill_switch: boolean;
      schema_ref: string;
    }>;
    if (!body.flag_id) {
      return reply.code(400).send({ error: 'ValidationError', details: ['missing flag_id'] });
    }
    if (body.kind && !FLAG_KINDS.includes(body.kind)) {
      return reply.code(400).send({ error: 'ValidationError', details: ['invalid kind'] });
    }
    const flag = await upsertFlag({
      flag_id: body.flag_id,
      description: body.description,
      kind: body.kind,
      default_value: body.default_value,
      kill_switch: body.kill_switch,
      schema_ref: body.schema_ref,
    });
    return reply.code(200).send({ data: { flag } });
  });

  app.get('/api/flags', { preHandler: requireAuth }, async (_req, reply) => {
    const flags = await listFlags();
    return reply.code(200).send({ data: { flags } });
  });

  app.get<{ Params: { flag_id: string } }>(
    '/api/flags/:flag_id',
    { preHandler: requireAuth },
    async (req, reply) => {
      const flag = await getFlag(req.params.flag_id);
      if (!flag) return reply.code(404).send({ error: 'NotFound' });
      return reply.code(200).send({ data: { flag } });
    },
  );

  app.post<{ Params: { flag_id: string } }>(
    '/api/flags/:flag_id/kill-switch',
    { preHandler: requireAuth },
    async (req, reply) => {
      const body = req.body as Partial<{ engaged: boolean }>;
      if (typeof body.engaged !== 'boolean') {
        return reply.code(400).send({ error: 'ValidationError', details: ['missing engaged'] });
      }
      const flag = await setKillSwitch(req.params.flag_id, body.engaged);
      if (!flag) return reply.code(404).send({ error: 'NotFound' });
      return reply.code(200).send({ data: { flag } });
    },
  );

  app.post<{ Params: { flag_id: string } }>(
    '/api/flags/:flag_id/rollouts',
    { preHandler: requireAuth },
    async (req, reply) => {
      const body = req.body as Partial<{
        tenant_id: string;
        predicate: Record<string, unknown>;
        value: unknown;
        priority: number;
        active: boolean;
      }>;
      if (body.value === undefined) {
        return reply.code(400).send({ error: 'ValidationError', details: ['missing value'] });
      }
      const record = await upsertRollout({
        flag_id: req.params.flag_id,
        tenant_id: body.tenant_id,
        predicate: body.predicate,
        value: body.value,
        priority: body.priority,
        active: body.active,
      });
      return reply.code(201).send({ data: { rollout: record } });
    },
  );

  app.post<{ Params: { flag_id: string } }>(
    '/api/flags/:flag_id/evaluate',
    { preHandler: requireAuth },
    async (req, reply) => {
      const body = req.body as Partial<{
        tenant_id: string;
        persona_id: string;
        bu_id: string;
        attributes: Record<string, unknown>;
      }>;
      const result = await evaluate(req.params.flag_id, body);
      return reply.code(200).send({ data: { evaluation: result } });
    },
  );
}
