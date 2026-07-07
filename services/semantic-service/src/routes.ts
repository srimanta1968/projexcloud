import type { FastifyInstance } from 'fastify';
import {
  createBridge,
  deprecateOntology,
  evaluate,
  getActiveOntology,
  getPlan,
  listBridges,
  listOntologies,
  listPolicies,
  plan,
  registerOntology,
  registerPolicy,
  updatePlanStatus,
} from '@projexlight/sdk-semantic';
import type { EvaluateContext } from '@projexlight/sdk-semantic';
import type {
  DomainOntologyBundle,
  SemanticIntent,
  PlanStatus,
} from '@projexlight/contracts';

/**
 * HTTP surface for services/semantic-service.
 *
 * Endpoints (PRD §5.7 public API + planner / policy / bridge admin):
 *   POST /ontology/register       — register a DomainOntologyBundle
 *   GET  /ontology                — list ontologies
 *   GET  /ontology/:name/active   — fetch active ontology by name
 *   POST /ontology/:id/deprecate  — deprecate an ontology version
 *   POST /intent/plan             — Intent → Plan (G9 AC-8)
 *   POST /plan/:id/status         — advance plan lifecycle
 *   GET  /plan/:id                — read a plan
 *   POST /policy/register         — register a SemanticPolicy (IQL → ABAC+ReBAC)
 *   GET  /policy                  — list policies
 *   POST /policy/:id/evaluate     — evaluate a SemanticPolicy (G9 AC-9)
 *   POST /bridge                  — register a cross-domain bridge
 *   GET  /bridge                  — list bridges
 */
export async function registerRoutes(
  app: FastifyInstance,
  opts: { mountHealth?: boolean } = {},
): Promise<void> {
  // Skip /health when mounted inside an aggregator (the api-gateway already owns /health);
  // the standalone binary registers it (default). Prevents FST_ERR_DUPLICATED_ROUTE.
  if (opts.mountHealth !== false) {
    app.get('/health', async () => ({ ok: true, service: 'semantic-service' }));
  }

  app.post<{ Body: { bundle: DomainOntologyBundle; bundle_ref: string; activate?: boolean } }>(
    '/ontology/register',
    async (req, reply) => {
      const body = req.body;
      if (!body?.bundle || !body?.bundle_ref) {
        return reply.code(400).send({ success: false, error: 'bundle and bundle_ref required' });
      }
      try {
        const result = await registerOntology({
          bundle: body.bundle,
          bundle_ref: body.bundle_ref,
          activate: body.activate ?? true,
        });
        return { success: true, data: result };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return reply.code(400).send({ success: false, error: msg });
      }
    },
  );

  app.get('/ontology', async () => ({ success: true, data: await listOntologies() }));

  app.get<{ Params: { name: string } }>('/ontology/:name/active', async (req, reply) => {
    try {
      const o = await getActiveOntology(req.params.name);
      return { success: true, data: o };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return reply.code(404).send({ success: false, error: msg });
    }
  });

  app.post<{ Params: { id: string }; Body: { reason: string } }>(
    '/ontology/:id/deprecate',
    async (req, reply) => {
      const reason = req.body?.reason ?? 'unspecified';
      try {
        const o = await deprecateOntology(req.params.id, reason);
        return { success: true, data: o };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return reply.code(404).send({ success: false, error: msg });
      }
    },
  );

  app.post<{ Body: { intent: SemanticIntent; agent_run_id?: string | null } }>(
    '/intent/plan',
    async (req, reply) => {
      const { intent, agent_run_id } = req.body ?? {};
      if (!intent?.tenant_id || !intent?.ontology_id || !intent?.goal || !intent?.subject || !intent?.trace_id) {
        return reply.code(400).send({ success: false, error: 'intent missing required fields' });
      }
      try {
        const p = await plan(intent, { agent_run_id: agent_run_id ?? null });
        return { success: true, data: p };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return reply.code(400).send({ success: false, error: msg });
      }
    },
  );

  app.get<{ Params: { id: string } }>('/plan/:id', async (req, reply) => {
    const p = await getPlan(req.params.id);
    if (!p) return reply.code(404).send({ success: false, error: `plan ${req.params.id} not found` });
    return { success: true, data: p };
  });

  app.post<{ Params: { id: string }; Body: { status: PlanStatus } }>(
    '/plan/:id/status',
    async (req, reply) => {
      const status = req.body?.status;
      if (!status) return reply.code(400).send({ success: false, error: 'status required' });
      try {
        await updatePlanStatus(req.params.id, status);
        return { success: true, data: { plan_id: req.params.id, status } };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return reply.code(404).send({ success: false, error: msg });
      }
    },
  );

  app.post<{
    Body: {
      tenant_id: string | null;
      ontology_id: string;
      name: string;
      description?: string;
      iql_source: string;
      activate?: boolean;
    };
  }>('/policy/register', async (req, reply) => {
    const body = req.body;
    if (!body?.ontology_id || !body?.name || !body?.iql_source) {
      return reply.code(400).send({ success: false, error: 'ontology_id, name, iql_source required' });
    }
    try {
      const p = await registerPolicy({
        tenant_id: body.tenant_id ?? null,
        ontology_id: body.ontology_id,
        name: body.name,
        description: body.description,
        iql_source: body.iql_source,
        activate: body.activate ?? false,
      });
      return { success: true, data: p };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return reply.code(400).send({ success: false, error: msg });
    }
  });

  app.get<{ Querystring: { tenant_id?: string; ontology_id?: string } }>(
    '/policy',
    async (req) => {
      const policies = await listPolicies({
        tenant_id: req.query.tenant_id ?? null,
        ontology_id: req.query.ontology_id,
      });
      return { success: true, data: policies };
    },
  );

  app.post<{ Params: { id: string }; Body: EvaluateContext }>(
    '/policy/:id/evaluate',
    async (req, reply) => {
      const ctx = req.body;
      if (!ctx?.subject_type || !ctx?.action || !ctx?.resource_type || !ctx?.trace_id) {
        return reply.code(400).send({ success: false, error: 'subject_type, action, resource_type, trace_id required' });
      }
      try {
        const d = await evaluate(req.params.id, ctx);
        return { success: true, data: d };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return reply.code(404).send({ success: false, error: msg });
      }
    },
  );

  app.post<{
    Body: {
      from_object_type_id: string;
      to_object_type_id: string;
      access_mode?: 'read-only' | 'read-write';
      requires_cross_tenant_consent?: boolean;
    };
  }>('/bridge', async (req, reply) => {
    const body = req.body;
    if (!body?.from_object_type_id || !body?.to_object_type_id) {
      return reply.code(400).send({ success: false, error: 'from_object_type_id and to_object_type_id required' });
    }
    try {
      const b = await createBridge(body);
      return { success: true, data: b };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return reply.code(400).send({ success: false, error: msg });
    }
  });

  app.get('/bridge', async () => ({ success: true, data: await listBridges() }));
}
