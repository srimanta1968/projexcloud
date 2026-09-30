import type { FastifyInstance } from 'fastify';
import { requireAuth } from '@projexlight/sdk-identity';
import { getCatalogEntry, listCatalog, type CatalogFilter } from '../services/catalogService';
import { validateCredential } from '../services/keyValidationService';
import { getCertificationRun, listCertificationRuns, startCertificationRun, type StartCertificationInput } from '../services/certificationService';
import { previewVoice, type PreviewInput } from '../services/voicePreviewService';
import { sendError } from './sendError';

/**
 * sdk-speech HTTP surface under /api/speech/* (VA·E4), mounted by the api-gateway.
 * The catalog is global reference data: any authenticated tenant reads the same rows.
 */
export async function registerRoutes(app: FastifyInstance): Promise<void> {
  // TK-4489 — the provider catalog.
  app.get('/api/speech/catalog', { preHandler: requireAuth }, async (req, reply) => {
    const q = (req.query ?? {}) as CatalogFilter;
    try {
      const entries = await listCatalog({ layer: q.layer, provider: q.provider, certified: q.certified });
      return reply.code(200).send({ data: { entries, total: entries.length } });
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.get('/api/speech/catalog/:entry_id', { preHandler: requireAuth }, async (req, reply) => {
    const { entry_id } = req.params as { entry_id: string };
    try {
      return reply.code(200).send({ data: { entry: await getCatalogEntry(entry_id) } });
    } catch (err) {
      return sendError(reply, err);
    }
  });

  // TK-4491 — validate one of the tenant's keys and probe its capacity. The outcome is a
  // typed status in a 200 body (a rejected key is a result, not a request error).
  app.post('/api/speech/credentials/:binding_id/validate', { preHandler: requireAuth }, async (req, reply) => {
    const tenantId = req.auth?.tenant_id;
    if (!tenantId) return reply.code(400).send({ error: 'ValidationError', details: ['tenant_id is required'] });
    const { binding_id } = req.params as { binding_id: string };
    try {
      return reply.code(200).send({ data: await validateCredential(tenantId, binding_id) });
    } catch (err) {
      return sendError(reply, err);
    }
  });

  // TK-4492 — hear a voice with the tenant's own TTS key before choosing it.
  app.post('/api/speech/voices/preview', { preHandler: requireAuth }, async (req, reply) => {
    const tenantId = req.auth?.tenant_id;
    if (!tenantId) return reply.code(400).send({ error: 'ValidationError', details: ['tenant_id is required'] });
    try {
      return reply.code(200).send({ data: { preview: await previewVoice(tenantId, (req.body ?? {}) as PreviewInput) } });
    } catch (err) {
      return sendError(reply, err);
    }
  });

  // TK-4519 — certify an entry FOR THIS TENANT with the tenant's own vault key (the per-tenant
  // enablement of an uncertified pair). stt/tts need a reference key of the other layer.
  // 202: queued; a voice-runtime worker runs it.
  app.post('/api/speech/catalog/:entry_id/certification-runs', { preHandler: requireAuth }, async (req, reply) => {
    const tenantId = req.auth?.tenant_id;
    if (!tenantId) return reply.code(400).send({ error: 'ValidationError', details: ['tenant_id is required'] });
    const { entry_id } = req.params as { entry_id: string };
    try {
      const actor = req.auth?.primary_persona_id ?? req.auth?.sub ?? 'unknown';
      const run = await startCertificationRun('tenant', tenantId, entry_id, (req.body ?? {}) as StartCertificationInput, actor);
      return reply.code(202).send({ data: { run } });
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.get('/api/speech/catalog/:entry_id/certification-runs', { preHandler: requireAuth }, async (req, reply) => {
    const tenantId = req.auth?.tenant_id;
    if (!tenantId) return reply.code(400).send({ error: 'ValidationError', details: ['tenant_id is required'] });
    const { entry_id } = req.params as { entry_id: string };
    try {
      return reply.code(200).send({ data: { runs: await listCertificationRuns(entry_id, tenantId) } });
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.get('/api/speech/certification-runs/:run_id', { preHandler: requireAuth }, async (req, reply) => {
    const tenantId = req.auth?.tenant_id;
    if (!tenantId) return reply.code(400).send({ error: 'ValidationError', details: ['tenant_id is required'] });
    const { run_id } = req.params as { run_id: string };
    try {
      return reply.code(200).send({ data: { run: await getCertificationRun(run_id, tenantId) } });
    } catch (err) {
      return sendError(reply, err);
    }
  });
}
