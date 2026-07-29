import { FastifyInstance, FastifyReply } from 'fastify';
import { requireAuth } from '@projexlight/sdk-identity';
import {
  createRun,
  getRunById,
  listRuns,
  savePreview,
  saveMapping,
  saveTransformPlan,
  saveDryRunResult,
  createTemplate,
  listTemplates,
  getTemplate,
  publishTemplateVersion,
  DuplicateImportRun,
  ImportRunNotFoundError,
  InvalidRunStatusTransition,
  MappingTemplateNotFound,
} from '../services/runService';
import { buildPreview } from '../services/previewService';
import { suggestMapping, confirmMapping, UnknownMappingColumn, UnknownMappingTarget } from '../services/mappingAssistantService';
import { buildTransformPlan } from '../services/transformService';
import { runDryRun, DryRunWroteError } from '../services/dryRunService';
import {
  commitRun,
  rollbackRun,
  listExceptions,
  listLineage,
  AttestationNotSigned,
  ImportRunLocked,
  ImportRunNotFound,
  InvalidRunTransition,
  RollbackBlockedByDownstreamAction,
  RollbackWindowClosed,
} from '../services/commitService';
import {
  CANONICAL_TARGETS,
  type FieldMapping,
  type ImportRunStatus,
  type MappingTemplateKind,
  type SchemaPreview,
  type TransformPlan,
} from '../models/import.model';

/**
 * sdk-import Fastify routes (P16 · EP-375 · PCF-02-5).
 *
 * The lifecycle in URLs: create a run, preview it, ask for mapping suggestions,
 * confirm the mapping, build a transform plan, dry-run it, then commit — and
 * within the rollback window, undo it.
 *
 * Status codes follow MUST-54: the two collection-root creates and a new template
 * version return 201; every stage action returns 200 because it moves an existing
 * run rather than creating a resource; reads return 200.
 *
 * Typed service errors carry their own status and code, and the mapper preserves
 * both — a caller needs to distinguish ATTESTATION_NOT_SIGNED (fix the paperwork)
 * from ROLLBACK_BLOCKED_BY_DOWNSTREAM_ACTION (you cannot undo this) from
 * IMPORT_RUN_LOCKED (retry shortly).
 */

interface DomainError {
  status: number;
  code: string;
  message: string;
}

function isDomainError(err: unknown): err is DomainError & Error {
  return (
    err instanceof Error &&
    typeof (err as Partial<DomainError>).status === 'number' &&
    typeof (err as Partial<DomainError>).code === 'string'
  );
}

function sendDomainError(reply: FastifyReply, err: unknown): unknown {
  if (!isDomainError(err)) throw err;
  const body: Record<string, unknown> = { error: err.name, code: err.code, message: err.message };
  if (err instanceof DuplicateImportRun) body.existing_run_id = err.existing_run_id;
  if (err instanceof InvalidRunStatusTransition) {
    body.from = err.from;
    body.to = err.to;
    body.allowed = err.allowed;
  }
  if (err instanceof InvalidRunTransition) {
    body.from = err.from;
    body.to = err.to;
  }
  if (err instanceof RollbackBlockedByDownstreamAction) body.blocker = err.blocker;
  if (err instanceof RollbackWindowClosed) body.rollback_deadline = err.deadline;
  return reply.code(err.status).send(body);
}

function validationError(reply: FastifyReply, message: string): unknown {
  return reply.code(400).send({ error: 'ValidationError', code: 'VALIDATION_ERROR', message });
}

export async function registerRoutes(app: FastifyInstance): Promise<void> {
  /* ------------------------------------------------------------- runs */

  app.post('/api/imports/runs', { preHandler: requireAuth }, async (req, reply) => {
    const body = req.body as Partial<{
      tenant_id: string;
      source_kind: string;
      file_fingerprint: string;
      source_ref: string;
      file_name: string;
      mapping_template_id: string;
      attestation_id: string;
      row_count: number;
      rollback_window_hours: number;
      started_by: string;
      metadata: Record<string, unknown>;
    }>;
    if (!body.tenant_id || !body.source_kind || !body.file_fingerprint) {
      return validationError(reply, 'tenant_id, source_kind and file_fingerprint are required');
    }
    try {
      const run = await createRun({
        tenant_id: body.tenant_id,
        source_kind: body.source_kind,
        file_fingerprint: body.file_fingerprint,
        source_ref: body.source_ref,
        file_name: body.file_name,
        mapping_template_id: body.mapping_template_id,
        attestation_id: body.attestation_id,
        row_count: body.row_count,
        rollback_window_hours: body.rollback_window_hours,
        started_by: body.started_by,
        metadata: body.metadata,
      });
      return reply.code(201).send({ data: { run } });
    } catch (err) {
      return sendDomainError(reply, err);
    }
  });

  app.get<{
    Querystring: {
      tenant_id?: string;
      status?: ImportRunStatus;
      source_kind?: string;
      limit?: string;
      offset?: string;
    };
  }>('/api/imports/runs', { preHandler: requireAuth }, async (req, reply) => {
    if (!req.query.tenant_id) return validationError(reply, 'tenant_id query param required');
    const runs = await listRuns({
      tenant_id: req.query.tenant_id,
      status: req.query.status,
      source_kind: req.query.source_kind,
      limit: req.query.limit ? Number(req.query.limit) : undefined,
      offset: req.query.offset ? Number(req.query.offset) : undefined,
    });
    return reply.code(200).send({ data: { runs, count: runs.length } });
  });

  app.get<{ Params: { run_id: string }; Querystring: { tenant_id?: string } }>(
    '/api/imports/runs/:run_id',
    { preHandler: requireAuth },
    async (req, reply) => {
      if (!req.query.tenant_id) return validationError(reply, 'tenant_id query param required');
      try {
        const run = await getRunById(req.query.tenant_id, req.params.run_id);
        const lineage = await listLineage(req.query.tenant_id, req.params.run_id);
        return reply.code(200).send({ data: { run, lineage } });
      } catch (err) {
        return sendDomainError(reply, err);
      }
    },
  );

  /* ---------------------------------------------------------- preview */

  app.post<{ Params: { run_id: string } }>(
    '/api/imports/runs/:run_id/preview',
    { preHandler: requireAuth },
    async (req, reply) => {
      const body = (req.body ?? {}) as Partial<{
        tenant_id: string;
        content: string;
        rows: Array<Record<string, unknown>>;
        delimiter: string;
        has_header_row: boolean;
        encoding: string;
        sample_size: number;
      }>;
      if (!body.tenant_id) return validationError(reply, 'tenant_id is required');
      if (!body.content && !(body.rows && body.rows.length > 0)) {
        return validationError(reply, 'either content or a non-empty rows[] is required');
      }
      try {
        const preview = buildPreview({
          content: body.content,
          rows: body.rows,
          delimiter: body.delimiter,
          has_header_row: body.has_header_row,
          encoding: body.encoding,
          sample_size: body.sample_size,
        });
        const run = await savePreview(body.tenant_id, req.params.run_id, preview);
        return reply.code(200).send({ data: { run, preview } });
      } catch (err) {
        return sendDomainError(reply, err);
      }
    },
  );

  /* ------------------------------------------------ mapping suggestions */

  app.post<{ Params: { run_id: string } }>(
    '/api/imports/runs/:run_id/mapping-suggestions',
    { preHandler: requireAuth },
    async (req, reply) => {
      const body = (req.body ?? {}) as Partial<{ tenant_id: string }>;
      if (!body.tenant_id) return validationError(reply, 'tenant_id is required');
      try {
        const run = await getRunById(body.tenant_id, req.params.run_id);
        if (!run.preview) {
          return reply.code(409).send({
            error: 'PreviewRequired',
            code: 'PREVIEW_REQUIRED',
            message: 'run the preview before asking for mapping suggestions',
          });
        }
        const suggestions = await suggestMapping(run.preview as SchemaPreview, {
          tenant_id: body.tenant_id,
          source_system: run.source_kind,
        });
        // Suggestions are NOT persisted as the mapping: nothing is applied until a
        // human confirms it through PUT /mapping.
        return reply.code(200).send({
          data: { suggestions, count: suggestions.length, confirmed: false },
        });
      } catch (err) {
        return sendDomainError(reply, err);
      }
    },
  );

  app.put<{ Params: { run_id: string } }>(
    '/api/imports/runs/:run_id/mapping',
    { preHandler: requireAuth },
    async (req, reply) => {
      const body = (req.body ?? {}) as Partial<{
        tenant_id: string;
        confirmations: Array<{ source_column: string; target: string; confirmed_by: string; external_system?: string }>;
        mapping_template_id: string;
      }>;
      if (!body.tenant_id || !Array.isArray(body.confirmations)) {
        return validationError(reply, 'tenant_id and confirmations[] are required');
      }
      try {
        const run = await getRunById(body.tenant_id, req.params.run_id);
        if (!run.preview) {
          return reply.code(409).send({
            error: 'PreviewRequired',
            code: 'PREVIEW_REQUIRED',
            message: 'run the preview before confirming a mapping',
          });
        }
        const suggestions = await suggestMapping(run.preview as SchemaPreview, {
          tenant_id: body.tenant_id,
          source_system: run.source_kind,
        });
        const field_map = confirmMapping(
          suggestions,
          body.confirmations.map((c) => ({
            source_column: c.source_column,
            target: c.target as never,
            confirmed_by: c.confirmed_by,
            external_system: c.external_system,
          })),
          CANONICAL_TARGETS,
        );
        const updated = await saveMapping(
          body.tenant_id,
          req.params.run_id,
          field_map,
          body.mapping_template_id,
        );
        return reply.code(200).send({ data: { run: updated, field_map } });
      } catch (err) {
        if (err instanceof UnknownMappingColumn || err instanceof UnknownMappingTarget) {
          return sendDomainError(reply, err);
        }
        return sendDomainError(reply, err);
      }
    },
  );

  /* --------------------------------------------------- transform plan */

  app.post<{ Params: { run_id: string } }>(
    '/api/imports/runs/:run_id/transform-plan',
    { preHandler: requireAuth },
    async (req, reply) => {
      const body = (req.body ?? {}) as Partial<{
        tenant_id: string;
        enable_source_state_mapping: boolean;
        default_calling_region: string;
        default_country: string;
      }>;
      if (!body.tenant_id) return validationError(reply, 'tenant_id is required');
      try {
        const run = await getRunById(body.tenant_id, req.params.run_id);
        const plan = buildTransformPlan(run.field_map as Record<string, FieldMapping>, {
          enable_source_state_mapping: body.enable_source_state_mapping,
          default_calling_region: body.default_calling_region,
          default_country: body.default_country,
        });
        const updated = await saveTransformPlan(body.tenant_id, req.params.run_id, plan);
        return reply.code(200).send({ data: { run: updated, transform_plan: plan } });
      } catch (err) {
        return sendDomainError(reply, err);
      }
    },
  );

  /* --------------------------------------------------------- dry run */

  app.post<{ Params: { run_id: string } }>(
    '/api/imports/runs/:run_id/dry-run',
    { preHandler: requireAuth },
    async (req, reply) => {
      const body = (req.body ?? {}) as Partial<{
        tenant_id: string;
        rows: Array<Record<string, string>>;
      }>;
      if (!body.tenant_id || !Array.isArray(body.rows)) {
        return validationError(reply, 'tenant_id and rows[] are required');
      }
      try {
        const run = await getRunById(body.tenant_id, req.params.run_id);
        if (!run.transform_plan) {
          return reply.code(409).send({
            error: 'TransformPlanRequired',
            code: 'TRANSFORM_PLAN_REQUIRED',
            message: 'build the transform plan before running a dry run',
          });
        }
        const result = await runDryRun({
          tenant_id: body.tenant_id,
          run_id: req.params.run_id,
          rows: body.rows,
          field_map: run.field_map as Record<string, FieldMapping>,
          plan: run.transform_plan as TransformPlan,
          attestation_id: run.attestation_id,
        });
        // Recording that a dry run HAPPENED is a deliberate write, outside the
        // proven zero-write region of the simulation itself.
        const updated = await saveDryRunResult(body.tenant_id, req.params.run_id, result);
        return reply.code(200).send({ data: { run: updated, dry_run: result } });
      } catch (err) {
        if (err instanceof DryRunWroteError) return sendDomainError(reply, err);
        return sendDomainError(reply, err);
      }
    },
  );

  /* ------------------------------------------------------ exceptions */

  app.get<{
    Params: { run_id: string };
    Querystring: { tenant_id?: string; limit?: string; offset?: string };
  }>('/api/imports/runs/:run_id/exceptions', { preHandler: requireAuth }, async (req, reply) => {
    if (!req.query.tenant_id) return validationError(reply, 'tenant_id query param required');
    try {
      await getRunById(req.query.tenant_id, req.params.run_id);
      const exceptions = await listExceptions(req.query.tenant_id, req.params.run_id, {
        limit: req.query.limit ? Number(req.query.limit) : undefined,
        offset: req.query.offset ? Number(req.query.offset) : undefined,
      });
      return reply.code(200).send({ data: { exceptions, count: exceptions.length } });
    } catch (err) {
      return sendDomainError(reply, err);
    }
  });

  /* ---------------------------------------------------------- commit */

  app.post<{ Params: { run_id: string } }>(
    '/api/imports/runs/:run_id/commit',
    { preHandler: requireAuth },
    async (req, reply) => {
      const body = (req.body ?? {}) as Partial<{
        tenant_id: string;
        rows: Array<Record<string, string>>;
        consent: { value_column: string; purpose: string; captured_at_column: string };
        actor_id: string;
      }>;
      if (!body.tenant_id || !Array.isArray(body.rows)) {
        return validationError(reply, 'tenant_id and rows[] are required');
      }
      try {
        const result = await commitRun({
          tenant_id: body.tenant_id,
          run_id: req.params.run_id,
          rows: body.rows,
          consent: body.consent ?? null,
          actor_id: body.actor_id,
        });
        return reply.code(200).send({ data: result });
      } catch (err) {
        return sendDomainError(reply, err);
      }
    },
  );

  /* -------------------------------------------------------- rollback */

  app.post<{ Params: { run_id: string } }>(
    '/api/imports/runs/:run_id/rollback',
    { preHandler: requireAuth },
    async (req, reply) => {
      const body = (req.body ?? {}) as Partial<{
        tenant_id: string;
        reason: string;
        actor_id: string;
      }>;
      if (!body.tenant_id) return validationError(reply, 'tenant_id is required');
      try {
        const result = await rollbackRun({
          tenant_id: body.tenant_id,
          run_id: req.params.run_id,
          reason: body.reason,
          actor_id: body.actor_id,
        });
        return reply.code(200).send({ data: result });
      } catch (err) {
        return sendDomainError(reply, err);
      }
    },
  );

  /* -------------------------------------------------------- templates */

  app.post('/api/imports/mapping-templates', { preHandler: requireAuth }, async (req, reply) => {
    const body = req.body as Partial<{
      tenant_id: string;
      slug: string;
      name: string;
      description: string;
      kind: MappingTemplateKind;
      field_map: Record<string, FieldMapping>;
      transforms: unknown[];
      value_crosswalks: Record<string, unknown>;
      crosswalk_strategy: 'preserve_existing' | 'add_alias' | 'reject_conflict';
      created_by: string;
      metadata: Record<string, unknown>;
    }>;
    if (!body.tenant_id || !body.slug || !body.name) {
      return validationError(reply, 'tenant_id, slug and name are required');
    }
    try {
      const template = await createTemplate({
        tenant_id: body.tenant_id,
        slug: body.slug,
        name: body.name,
        description: body.description,
        kind: body.kind,
        field_map: body.field_map,
        transforms: body.transforms,
        value_crosswalks: body.value_crosswalks,
        crosswalk_strategy: body.crosswalk_strategy,
        created_by: body.created_by,
        metadata: body.metadata,
      });
      return reply.code(201).send({ data: { template } });
    } catch (err) {
      const code = (err as { code?: string }).code;
      if (code === '23505') {
        return reply.code(409).send({
          error: 'Conflict',
          code: 'DUPLICATE_TEMPLATE_VERSION',
          message: 'a template with this slug and version already exists for the tenant',
        });
      }
      return sendDomainError(reply, err);
    }
  });

  app.get<{
    Querystring: {
      tenant_id?: string;
      slug?: string;
      kind?: MappingTemplateKind;
      is_active?: string;
      limit?: string;
      offset?: string;
    };
  }>('/api/imports/mapping-templates', { preHandler: requireAuth }, async (req, reply) => {
    if (!req.query.tenant_id) return validationError(reply, 'tenant_id query param required');
    const templates = await listTemplates({
      tenant_id: req.query.tenant_id,
      slug: req.query.slug,
      kind: req.query.kind,
      is_active: req.query.is_active === undefined ? undefined : req.query.is_active === 'true',
      limit: req.query.limit ? Number(req.query.limit) : undefined,
      offset: req.query.offset ? Number(req.query.offset) : undefined,
    });
    return reply.code(200).send({ data: { templates, count: templates.length } });
  });

  app.post<{ Params: { template_id: string } }>(
    '/api/imports/mapping-templates/:template_id/version',
    { preHandler: requireAuth },
    async (req, reply) => {
      const body = (req.body ?? {}) as Partial<{
        tenant_id: string;
        name: string;
        description: string;
        field_map: Record<string, FieldMapping>;
        transforms: unknown[];
        value_crosswalks: Record<string, unknown>;
        crosswalk_strategy: 'preserve_existing' | 'add_alias' | 'reject_conflict';
        created_by: string;
      }>;
      if (!body.tenant_id) return validationError(reply, 'tenant_id is required');
      try {
        // 201: a version is a NEW row, never an edit of the previous one, which may
        // already be referenced by a committed run.
        const template = await publishTemplateVersion(body.tenant_id, req.params.template_id, {
          name: body.name,
          description: body.description,
          field_map: body.field_map,
          transforms: body.transforms,
          value_crosswalks: body.value_crosswalks,
          crosswalk_strategy: body.crosswalk_strategy,
          created_by: body.created_by,
        });
        return reply.code(201).send({ data: { template } });
      } catch (err) {
        return sendDomainError(reply, err);
      }
    },
  );
}

export {
  DuplicateImportRun,
  ImportRunNotFoundError,
  ImportRunNotFound,
  InvalidRunStatusTransition,
  MappingTemplateNotFound,
  AttestationNotSigned,
  ImportRunLocked,
  RollbackBlockedByDownstreamAction,
  RollbackWindowClosed,
  getTemplate,
};
