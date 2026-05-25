import type { FastifyInstance, FastifyPluginCallback } from 'fastify';
import {
  createModel,
  getModel,
  getActiveModel,
  activateModel,
  retireModel,
  listFeatureWeights,
  setFeatureWeight,
} from '../services/modelService';
import {
  scoreContact,
  nextBestAction,
  type ScoreContactInput,
} from '../services/scoringEngine';

/**
 * HTTP surface for sdk-lead-scoring (P7 §5.4 / AC-3).
 *
 *   POST /api/lead-scoring/models                — create a model
 *   GET  /api/lead-scoring/models/:id            — fetch a model
 *   POST /api/lead-scoring/models/:id/activate   — flip to active
 *   POST /api/lead-scoring/models/:id/retire     — flip to retired
 *   GET  /api/lead-scoring/models/:id/weights    — list feature weights
 *   PUT  /api/lead-scoring/models/:id/weights/:feature — tune one weight
 *   POST /api/lead-scoring/score                 — score a contact
 *   POST /api/lead-scoring/next-best-action      — score + recommend (one call)
 */
export const registerRoutes: FastifyPluginCallback = (app: FastifyInstance, _opts, done) => {
  app.post<{
    Body: {
      tenant_id?: string;
      vertical?: string;
      feature_set?: Record<string, unknown>;
      weights?: Record<string, number>;
      activate?: boolean;
    };
  }>('/api/lead-scoring/models', async (req, reply) => {
    const b = req.body ?? {};
    if (!b.tenant_id || !b.vertical) {
      return reply.code(400).send({ success: false, error: 'tenant_id and vertical are required' });
    }
    try {
      const data = await createModel({
        tenant_id: b.tenant_id,
        vertical: b.vertical,
        feature_set: b.feature_set,
        weights: b.weights,
        activate: b.activate,
      });
      return reply.code(201).send({ success: true, data });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return reply.code(400).send({ success: false, error: msg });
    }
  });

  app.get<{ Params: { id: string } }>('/api/lead-scoring/models/:id', async (req, reply) => {
    const data = await getModel(req.params.id);
    if (!data) return reply.code(404).send({ success: false, error: 'not found' });
    return { success: true, data };
  });

  app.post<{ Params: { id: string } }>(
    '/api/lead-scoring/models/:id/activate',
    async (req, reply) => {
      try {
        return { success: true, data: await activateModel(req.params.id) };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return reply.code(404).send({ success: false, error: msg });
      }
    },
  );

  app.post<{ Params: { id: string } }>(
    '/api/lead-scoring/models/:id/retire',
    async (req, reply) => {
      try {
        return { success: true, data: await retireModel(req.params.id) };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return reply.code(404).send({ success: false, error: msg });
      }
    },
  );

  app.get<{ Params: { id: string } }>(
    '/api/lead-scoring/models/:id/weights',
    async (req) => ({ success: true, data: await listFeatureWeights(req.params.id) }),
  );

  app.put<{
    Params: { id: string; feature: string };
    Body: { weight?: number };
  }>('/api/lead-scoring/models/:id/weights/:feature', async (req, reply) => {
    const weight = req.body?.weight;
    if (weight == null || !Number.isFinite(weight) || weight < 0) {
      return reply.code(400).send({ success: false, error: 'weight must be a non-negative finite number' });
    }
    try {
      return {
        success: true,
        data: await setFeatureWeight({
          model_id: req.params.id,
          feature: req.params.feature,
          weight,
        }),
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return reply.code(400).send({ success: false, error: msg });
    }
  });

  app.post<{ Body: ScoreContactInput }>('/api/lead-scoring/score', async (req, reply) => {
    const b = req.body;
    if (!b?.tenant_id || !b?.vertical || !b?.contact_id || !b?.trace_id) {
      return reply.code(400).send({
        success: false,
        error: 'tenant_id, vertical, contact_id, trace_id are required',
      });
    }
    try {
      return { success: true, data: await scoreContact(b) };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return reply.code(400).send({ success: false, error: msg });
    }
  });

  app.post<{ Body: ScoreContactInput }>(
    '/api/lead-scoring/next-best-action',
    async (req, reply) => {
      const b = req.body;
      if (!b?.tenant_id || !b?.vertical || !b?.contact_id || !b?.trace_id) {
        return reply.code(400).send({
          success: false,
          error: 'tenant_id, vertical, contact_id, trace_id are required',
        });
      }
      try {
        const scoring = await scoreContact(b);
        const action = await nextBestAction(scoring);
        return { success: true, data: { scoring, action } };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return reply.code(400).send({ success: false, error: msg });
      }
    },
  );

  // Active-model lookup for ops UIs.
  app.get<{
    Querystring: { tenant_id?: string; vertical?: string };
  }>('/api/lead-scoring/models/active', async (req, reply) => {
    const q = req.query ?? {};
    if (!q.tenant_id || !q.vertical) {
      return reply.code(400).send({
        success: false,
        error: 'tenant_id and vertical query params required',
      });
    }
    const data = await getActiveModel(q.tenant_id, q.vertical);
    if (!data) return reply.code(404).send({ success: false, error: 'no active model' });
    return { success: true, data };
  });

  done();
};
