import { dataService } from '@projexlight/db-runtime';
import {
  RUN_TRANSITIONS,
  type CrosswalkStrategy,
  type DryRunResult,
  type FieldMapping,
  type ImportRun,
  type ImportRunStatus,
  type MappingTemplateKind,
  type SchemaPreview,
  type TransformPlan,
} from '../models/import.model';

/**
 * sdk-import run and mapping-template persistence (P16 · EP-375 · PCF-02-5).
 *
 * The state machine lives here, in one place: every status move goes through
 * assertTransition, so an endpoint cannot quietly skip preview or jump straight
 * to commit. The commit and rollback moves belong to commitService, which owns
 * the run lock.
 */

const RUN_COLS = `
  run_id, tenant_id, source_kind, source_ref, file_fingerprint, file_name, status,
  mapping_template_id, field_map, transform_plan, preview, dry_run_result, attestation_id,
  row_count, committed_row_count, exception_count, rollback_window, rollback_deadline,
  rolled_back_at, rollback_reason, quarantine_reason, committed_at, started_by,
  correlation_id, metadata, created_at, updated_at`;

const TEMPLATE_COLS = `
  template_id, tenant_id, slug, name, description, kind, version, parent_template_id,
  field_map, transforms, value_crosswalks, crosswalk_strategy, use_count, is_active,
  created_by, metadata, created_at, updated_at`;

export interface MappingTemplate {
  template_id: string;
  tenant_id: string;
  slug: string;
  name: string;
  description: string | null;
  kind: MappingTemplateKind;
  version: number;
  parent_template_id: string | null;
  field_map: Record<string, FieldMapping>;
  transforms: unknown[];
  value_crosswalks: Record<string, unknown>;
  crosswalk_strategy: CrosswalkStrategy;
  use_count: number;
  is_active: boolean;
  created_by: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export class ImportRunNotFoundError extends Error {
  readonly status = 404;
  readonly code = 'IMPORT_RUN_NOT_FOUND';
  constructor(public run_id: string) {
    super(`[sdk-import] import run ${run_id} not found for tenant`);
    this.name = 'ImportRunNotFoundError';
  }
}

export class MappingTemplateNotFound extends Error {
  readonly status = 404;
  readonly code = 'MAPPING_TEMPLATE_NOT_FOUND';
  constructor(public template_id: string) {
    super(`[sdk-import] mapping template ${template_id} not found for tenant`);
    this.name = 'MappingTemplateNotFound';
  }
}

export class InvalidRunStatusTransition extends Error {
  readonly status = 409;
  readonly code = 'INVALID_RUN_TRANSITION';
  constructor(
    public run_id: string,
    public from: ImportRunStatus,
    public to: ImportRunStatus,
    public allowed: readonly ImportRunStatus[],
  ) {
    super(
      `[sdk-import] run ${run_id} cannot move ${from} -> ${to} (allowed: ${allowed.join(', ') || 'none — terminal'})`,
    );
    this.name = 'InvalidRunStatusTransition';
  }
}

/** Raised when the same file+source is submitted twice for a tenant. */
export class DuplicateImportRun extends Error {
  readonly status = 409;
  readonly code = 'DUPLICATE_IMPORT_RUN';
  constructor(public file_fingerprint: string, public existing_run_id: string) {
    super(
      `[sdk-import] file ${file_fingerprint} was already submitted for this source — continue run ${existing_run_id} instead of starting a second one`,
    );
    this.name = 'DuplicateImportRun';
  }
}

function assertTransition(run: ImportRun, to: ImportRunStatus): void {
  if (run.status === to) return;
  const allowed = RUN_TRANSITIONS[run.status];
  if (!allowed.includes(to)) {
    throw new InvalidRunStatusTransition(run.run_id, run.status, to, allowed);
  }
}

export interface CreateRunInput {
  tenant_id: string;
  source_kind: string;
  file_fingerprint: string;
  source_ref?: string | null;
  file_name?: string | null;
  mapping_template_id?: string | null;
  attestation_id?: string | null;
  row_count?: number | null;
  rollback_window_hours?: number | null;
  started_by?: string | null;
  metadata?: Record<string, unknown>;
}

/**
 * Start a run. The UNIQUE(tenant, fingerprint, source_kind) constraint is the
 * commit-idempotency key, so a duplicate submission is answered with a 409 that
 * POINTS AT the existing run rather than a bare "already exists" — the caller
 * almost always wants to continue that run.
 */
export async function createRun(input: CreateRunInput): Promise<ImportRun> {
  const inserted = await dataService.one<ImportRun>(
    `INSERT INTO import.import_run
       (tenant_id, source_kind, source_ref, file_fingerprint, file_name, mapping_template_id,
        attestation_id, row_count, rollback_window, started_by, metadata)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8,
             COALESCE(make_interval(hours => $9::int), INTERVAL '24 hours'), $10, $11::jsonb)
     ON CONFLICT (tenant_id, file_fingerprint, source_kind) DO NOTHING
     RETURNING ${RUN_COLS}`,
    [
      input.tenant_id,
      input.source_kind,
      input.source_ref ?? null,
      input.file_fingerprint,
      input.file_name ?? null,
      input.mapping_template_id ?? null,
      input.attestation_id ?? null,
      input.row_count ?? null,
      input.rollback_window_hours ?? null,
      input.started_by ?? null,
      JSON.stringify(input.metadata ?? {}),
    ],
  );
  if (inserted) return inserted;

  const existing = await dataService.one<ImportRun>(
    `SELECT ${RUN_COLS} FROM import.import_run
      WHERE tenant_id = $1 AND file_fingerprint = $2 AND source_kind = $3`,
    [input.tenant_id, input.file_fingerprint, input.source_kind],
  );
  throw new DuplicateImportRun(input.file_fingerprint, existing?.run_id ?? 'unknown');
}

export async function getRunById(tenant_id: string, run_id: string): Promise<ImportRun> {
  const run = await dataService.one<ImportRun>(
    `SELECT ${RUN_COLS} FROM import.import_run WHERE tenant_id = $1 AND run_id = $2`,
    [tenant_id, run_id],
  );
  if (!run) throw new ImportRunNotFoundError(run_id);
  return run;
}

export async function listRuns(filter: {
  tenant_id: string;
  status?: ImportRunStatus;
  source_kind?: string;
  limit?: number;
  offset?: number;
}): Promise<ImportRun[]> {
  const limit = Math.min(Math.max(filter.limit ?? 50, 1), 500);
  const offset = Math.max(filter.offset ?? 0, 0);
  return dataService.rows<ImportRun>(
    `SELECT ${RUN_COLS} FROM import.import_run
      WHERE tenant_id = $1
        AND ($2::import.import_run_status IS NULL OR status = $2::import.import_run_status)
        AND ($3::text IS NULL OR source_kind = $3)
      ORDER BY created_at DESC
      LIMIT ${limit} OFFSET ${offset}`,
    [filter.tenant_id, filter.status ?? null, filter.source_kind ?? null],
  );
}

export async function savePreview(
  tenant_id: string,
  run_id: string,
  preview: SchemaPreview,
): Promise<ImportRun> {
  const run = await getRunById(tenant_id, run_id);
  assertTransition(run, 'previewing');
  const updated = await dataService.one<ImportRun>(
    `UPDATE import.import_run
        SET preview = $3::jsonb, row_count = COALESCE($4, row_count),
            status = 'previewing'
      WHERE tenant_id = $1 AND run_id = $2
      RETURNING ${RUN_COLS}`,
    [tenant_id, run_id, JSON.stringify(preview), preview.row_count],
  );
  return updated!;
}

export async function saveMapping(
  tenant_id: string,
  run_id: string,
  field_map: Record<string, FieldMapping>,
  mapping_template_id?: string | null,
): Promise<ImportRun> {
  const run = await getRunById(tenant_id, run_id);
  assertTransition(run, 'mapping');
  const updated = await dataService.one<ImportRun>(
    `UPDATE import.import_run
        SET field_map = $3::jsonb,
            mapping_template_id = COALESCE($4, mapping_template_id),
            status = 'mapping'
      WHERE tenant_id = $1 AND run_id = $2
      RETURNING ${RUN_COLS}`,
    [tenant_id, run_id, JSON.stringify(field_map), mapping_template_id ?? null],
  );
  return updated!;
}

export async function saveTransformPlan(
  tenant_id: string,
  run_id: string,
  plan: TransformPlan,
): Promise<ImportRun> {
  const run = await getRunById(tenant_id, run_id);
  // Building a plan does not move the run on its own — the plan is part of the
  // mapping stage, and re-planning after a dry run must not rewind the run.
  const updated = await dataService.one<ImportRun>(
    `UPDATE import.import_run SET transform_plan = $3::jsonb
      WHERE tenant_id = $1 AND run_id = $2
      RETURNING ${RUN_COLS}`,
    [tenant_id, run_id, JSON.stringify(plan)],
  );
  void run;
  return updated!;
}

export async function saveDryRunResult(
  tenant_id: string,
  run_id: string,
  result: DryRunResult,
): Promise<ImportRun> {
  const run = await getRunById(tenant_id, run_id);
  assertTransition(run, 'dry_run');
  const updated = await dataService.one<ImportRun>(
    `UPDATE import.import_run SET dry_run_result = $3::jsonb, status = 'dry_run'
      WHERE tenant_id = $1 AND run_id = $2
      RETURNING ${RUN_COLS}`,
    [tenant_id, run_id, JSON.stringify(result)],
  );
  return updated!;
}

/* ------------------------------------------------------------- templates */

export interface CreateTemplateInput {
  tenant_id: string;
  slug: string;
  name: string;
  description?: string | null;
  kind?: MappingTemplateKind;
  field_map?: Record<string, FieldMapping>;
  transforms?: unknown[];
  value_crosswalks?: Record<string, unknown>;
  crosswalk_strategy?: CrosswalkStrategy;
  created_by?: string | null;
  metadata?: Record<string, unknown>;
}

export async function createTemplate(input: CreateTemplateInput): Promise<MappingTemplate> {
  const row = await dataService.one<MappingTemplate>(
    `INSERT INTO import.mapping_template
       (tenant_id, slug, name, description, kind, field_map, transforms, value_crosswalks,
        crosswalk_strategy, created_by, metadata)
     VALUES ($1, $2, $3, $4, COALESCE($5::import.mapping_template_kind, 'custom'),
             $6::jsonb, $7::jsonb, $8::jsonb,
             COALESCE($9::import.crosswalk_strategy, 'preserve_existing'), $10, $11::jsonb)
     RETURNING ${TEMPLATE_COLS}`,
    [
      input.tenant_id,
      input.slug,
      input.name,
      input.description ?? null,
      input.kind ?? null,
      JSON.stringify(input.field_map ?? {}),
      JSON.stringify(input.transforms ?? []),
      JSON.stringify(input.value_crosswalks ?? {}),
      input.crosswalk_strategy ?? null,
      input.created_by ?? null,
      JSON.stringify(input.metadata ?? {}),
    ],
  );
  return row!;
}

export async function listTemplates(filter: {
  tenant_id: string;
  slug?: string;
  kind?: MappingTemplateKind;
  is_active?: boolean;
  limit?: number;
  offset?: number;
}): Promise<MappingTemplate[]> {
  const limit = Math.min(Math.max(filter.limit ?? 50, 1), 500);
  const offset = Math.max(filter.offset ?? 0, 0);
  return dataService.rows<MappingTemplate>(
    `SELECT ${TEMPLATE_COLS} FROM import.mapping_template
      WHERE tenant_id = $1
        AND ($2::text IS NULL OR slug = $2)
        AND ($3::import.mapping_template_kind IS NULL OR kind = $3::import.mapping_template_kind)
        AND ($4::boolean IS NULL OR is_active = $4)
      ORDER BY slug ASC, version DESC
      LIMIT ${limit} OFFSET ${offset}`,
    [filter.tenant_id, filter.slug ?? null, filter.kind ?? null, filter.is_active ?? null],
  );
}

export async function getTemplate(
  tenant_id: string,
  template_id: string,
): Promise<MappingTemplate> {
  const row = await dataService.one<MappingTemplate>(
    `SELECT ${TEMPLATE_COLS} FROM import.mapping_template
      WHERE tenant_id = $1 AND template_id = $2`,
    [tenant_id, template_id],
  );
  if (!row) throw new MappingTemplateNotFound(template_id);
  return row;
}

/**
 * Publish a NEW VERSION of a template.
 *
 * Always a new row, never an edit — the previous version may already be
 * referenced by a committed run, and rewriting it would make that run's lineage
 * describe a mapping that no longer exists. The database enforces the same rule
 * with a trigger; this is the supported way to satisfy it.
 */
export async function publishTemplateVersion(
  tenant_id: string,
  template_id: string,
  changes: Partial<Pick<CreateTemplateInput, 'name' | 'description' | 'field_map' | 'transforms' | 'value_crosswalks' | 'crosswalk_strategy' | 'created_by'>>,
): Promise<MappingTemplate> {
  const parent = await getTemplate(tenant_id, template_id);
  const next = await dataService.one<MappingTemplate>(
    `INSERT INTO import.mapping_template
       (tenant_id, slug, name, description, kind, version, parent_template_id, field_map,
        transforms, value_crosswalks, crosswalk_strategy, created_by, metadata)
     VALUES ($1, $2, $3, $4, $5::import.mapping_template_kind,
             (SELECT COALESCE(max(version), 0) + 1 FROM import.mapping_template
               WHERE tenant_id = $1 AND slug = $2),
             $6, $7::jsonb, $8::jsonb, $9::jsonb, $10::import.crosswalk_strategy, $11, $12::jsonb)
     RETURNING ${TEMPLATE_COLS}`,
    [
      tenant_id,
      parent.slug,
      changes.name ?? parent.name,
      changes.description ?? parent.description,
      parent.kind,
      parent.template_id,
      JSON.stringify(changes.field_map ?? parent.field_map),
      JSON.stringify(changes.transforms ?? parent.transforms),
      JSON.stringify(changes.value_crosswalks ?? parent.value_crosswalks),
      changes.crosswalk_strategy ?? parent.crosswalk_strategy,
      changes.created_by ?? parent.created_by,
      JSON.stringify(parent.metadata ?? {}),
    ],
  );
  return next!;
}
