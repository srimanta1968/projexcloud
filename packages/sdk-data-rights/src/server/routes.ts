import { FastifyInstance } from 'fastify';
import { requireAuth } from '@projexlight/sdk-identity';
import {
  getRequest,
  isReconciliationGreen,
  issueCertificate,
  listResidency,
  planExecutions,
  recordExecutionResult,
  recordReconciliationRun,
  submitRequest,
  touchResidency,
  transitionRequest,
} from '../services/dataRightsService';
import type { DsarKind, DsarStatus } from '../models/dataRights.model';

const DSAR_KINDS: DsarKind[] = [
  'access',
  'erasure',
  'rectification',
  'restriction',
  'objection',
  'portability',
];
const DSAR_STATES: DsarStatus[] = [
  'submitted',
  'identity-verified',
  'approval-pending',
  'grace-period',
  'executing',
  'certificate-issued',
  'audited',
  'rejected',
];

export async function registerRoutes(app: FastifyInstance): Promise<void> {
  // Residency registry ---------------------------------------------------
  app.post('/api/data-rights/residency/touch', { preHandler: requireAuth }, async (req, reply) => {
    const body = req.body as Partial<{
      person_id: string;
      pool_index: string;
      tenant_id: string;
      data_classes: string[];
    }>;
    if (!body.person_id || !body.pool_index || !body.tenant_id) {
      return reply.code(400).send({ error: 'ValidationError', details: ['missing fields'] });
    }
    const record = await touchResidency({
      person_id: body.person_id,
      pool_index: body.pool_index,
      tenant_id: body.tenant_id,
      data_classes: body.data_classes ?? [],
    });
    return reply.code(200).send({ data: { residency: record } });
  });

  app.get<{ Params: { person_id: string } }>(
    '/api/data-rights/residency/:person_id',
    { preHandler: requireAuth },
    async (req, reply) => {
      const residency = await listResidency(req.params.person_id);
      return reply.code(200).send({ data: { residency } });
    },
  );

  // DSAR request lifecycle -----------------------------------------------
  app.post('/api/data-rights/requests', { preHandler: requireAuth }, async (req, reply) => {
    const body = req.body as Partial<{
      person_id: string;
      tenant_id: string;
      kind: DsarKind;
      jurisdiction: string;
      approval_policy: 'auto' | 'manager-approval' | 'cross-tenant-approval';
    }>;
    if (!body.person_id || !body.kind) {
      return reply.code(400).send({ error: 'ValidationError', details: ['missing fields'] });
    }
    if (!DSAR_KINDS.includes(body.kind)) {
      return reply.code(400).send({ error: 'ValidationError', details: ['invalid kind'] });
    }
    const record = await submitRequest({
      person_id: body.person_id,
      tenant_id: body.tenant_id,
      kind: body.kind,
      jurisdiction: body.jurisdiction,
      approval_policy: body.approval_policy,
    });
    return reply.code(201).send({ data: { request: record } });
  });

  app.get<{ Params: { request_id: string } }>(
    '/api/data-rights/requests/:request_id',
    { preHandler: requireAuth },
    async (req, reply) => {
      const record = await getRequest(req.params.request_id);
      if (!record) return reply.code(404).send({ error: 'NotFound' });
      return reply.code(200).send({ data: { request: record } });
    },
  );

  app.post<{ Params: { request_id: string } }>(
    '/api/data-rights/requests/:request_id/transition',
    { preHandler: requireAuth },
    async (req, reply) => {
      const body = req.body as Partial<{ to: DsarStatus; approval_ref: string; grace_until: string }>;
      if (!body.to || !DSAR_STATES.includes(body.to)) {
        return reply.code(400).send({ error: 'ValidationError', details: ['invalid target state'] });
      }
      try {
        const record = await transitionRequest(req.params.request_id, body.to, {
          approval_ref: body.approval_ref,
          grace_until: body.grace_until ? new Date(body.grace_until) : undefined,
        });
        if (!record) return reply.code(404).send({ error: 'NotFound' });
        return reply.code(200).send({ data: { request: record } });
      } catch (err) {
        return reply.code(409).send({ error: 'InvalidTransition', details: [(err as Error).message] });
      }
    },
  );

  app.post<{ Params: { request_id: string } }>(
    '/api/data-rights/requests/:request_id/plan-executions',
    { preHandler: requireAuth },
    async (req, reply) => {
      const executions = await planExecutions(req.params.request_id);
      return reply.code(201).send({ data: { executions } });
    },
  );

  app.post<{ Params: { execution_id: string } }>(
    '/api/data-rights/executions/:execution_id/result',
    { preHandler: requireAuth },
    async (req, reply) => {
      const body = req.body as Partial<{
        status: 'succeeded' | 'failed';
        audit_entry_id: string;
        error_detail: string;
      }>;
      if (!body.status) {
        return reply.code(400).send({ error: 'ValidationError', details: ['missing status'] });
      }
      const record = await recordExecutionResult(
        req.params.execution_id,
        body.status,
        body.audit_entry_id,
        body.error_detail,
      );
      if (!record) return reply.code(404).send({ error: 'NotFound' });
      return reply.code(200).send({ data: { execution: record } });
    },
  );

  app.post<{ Params: { request_id: string } }>(
    '/api/data-rights/requests/:request_id/certificate',
    { preHandler: requireAuth },
    async (req, reply) => {
      const greenLight = await isReconciliationGreen();
      if (!greenLight) {
        return reply
          .code(409)
          .send({ error: 'ReconciliationRed', details: ['Reconciliation red — DSAR completion blocked'] });
      }
      const body = req.body as Partial<{
        shred_proofs: Record<string, string>;
        artifact_s3_key: string;
        signed_by_audit_entry_id: string;
      }>;
      const cert = await issueCertificate(
        req.params.request_id,
        body.shred_proofs ?? {},
        body.artifact_s3_key,
        body.signed_by_audit_entry_id,
      );
      return reply.code(201).send({ data: { certificate: cert } });
    },
  );

  // Reconciliation -------------------------------------------------------
  app.post('/api/data-rights/reconciliation/run', { preHandler: requireAuth }, async (req, reply) => {
    const body = req.body as Partial<{
      discrepancies: Array<{ person_id: string; pool_index: string; expected: string[]; actual: string[] }>;
    }>;
    const record = await recordReconciliationRun(body.discrepancies ?? []);
    return reply.code(200).send({ data: { reconciliation: record } });
  });
}
