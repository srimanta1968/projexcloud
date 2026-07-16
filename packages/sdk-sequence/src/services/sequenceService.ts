import { randomUUID } from 'crypto';
import { dataService } from '@projexlight/db-runtime';

/**
 * @projexlight/sdk-sequence — definition & enrollment service (P14·E1, TK-3613).
 *
 * CRUD for cadence sequences, reusable templates, and ordered steps, plus
 * event-based enrollment (form-submit / reply / stage-change triggers). Enrolling
 * the same persona twice into the same active sequence is idempotent — it returns
 * the existing enrollment rather than scheduling a duplicate run. No agent-mesh
 * (baseAgentService.register) coupling. The step-executor tick loop (TK-3614)
 * advances the execution_step rows this service seeds.
 */

const ACTIVE_EXEC_STATUSES = ['pending', 'scheduled', 'sending', 'deferred'];

/* --------------------------------------------------------------- sequences */

export interface SequenceRow {
  sequence_id: string;
  tenant_id: string;
  owner_persona_id: string | null;
  name: string;
  description: string | null;
  status: string;
  sequence_type: string;
  is_default: boolean;
  created_at: string;
  updated_at: string;
}

export interface CreateSequenceInput {
  tenant_id: string;
  name: string;
  description?: string;
  sequence_type?: string;
  owner_persona_id?: string;
  is_default?: boolean;
  metadata?: Record<string, unknown>;
}

const SEQ_COLS = `sequence_id, tenant_id, owner_persona_id, name, description, status,
  sequence_type, is_default, created_at, updated_at`;

/** Create a cadence sequence. */
export async function createSequence(input: CreateSequenceInput): Promise<SequenceRow> {
  const rows = await dataService.rows<SequenceRow>(
    `INSERT INTO sequence.sequence
       (tenant_id, name, description, sequence_type, owner_persona_id, is_default, metadata)
     VALUES ($1,$2,$3,COALESCE($4,'lead'),$5,COALESCE($6,false),$7::jsonb)
     RETURNING ${SEQ_COLS}`,
    [input.tenant_id, input.name, input.description ?? null, input.sequence_type ?? null,
     input.owner_persona_id ?? null, input.is_default ?? null, JSON.stringify(input.metadata ?? {})],
  );
  return rows[0];
}

/** Fetch a sequence by id (tenant-scoped). */
export async function getSequence(tenant_id: string, sequence_id: string): Promise<SequenceRow | null> {
  return dataService.one<SequenceRow>(
    `SELECT ${SEQ_COLS} FROM sequence.sequence WHERE tenant_id = $1 AND sequence_id = $2`,
    [tenant_id, sequence_id],
  );
}

/** List a tenant's sequences, newest first. */
export async function listSequences(tenant_id: string): Promise<SequenceRow[]> {
  return dataService.rows<SequenceRow>(
    `SELECT ${SEQ_COLS} FROM sequence.sequence WHERE tenant_id = $1 ORDER BY created_at DESC`,
    [tenant_id],
  );
}

/* --------------------------------------------------------------- templates */

export interface TemplateRow {
  template_id: string;
  tenant_id: string;
  name: string;
  channel: string;
  subject: string | null;
  body: string;
  category: string;
}

export interface CreateTemplateInput {
  tenant_id: string;
  name: string;
  channel?: string;
  subject?: string;
  body?: string;
  category?: string;
  variables?: unknown[];
}

/** Create a reusable channel template. */
export async function createTemplate(input: CreateTemplateInput): Promise<TemplateRow> {
  const rows = await dataService.rows<TemplateRow>(
    `INSERT INTO sequence.template (tenant_id, name, channel, subject, body, category, variables)
     VALUES ($1,$2,COALESCE($3,'email'),$4,COALESCE($5,''),COALESCE($6,'custom'),$7::jsonb)
     RETURNING template_id, tenant_id, name, channel, subject, body, category`,
    [input.tenant_id, input.name, input.channel ?? null, input.subject ?? null,
     input.body ?? null, input.category ?? null, JSON.stringify(input.variables ?? [])],
  );
  return rows[0];
}

/* ------------------------------------------------------------------- steps */

export interface StepRow {
  step_id: string;
  tenant_id: string;
  sequence_id: string;
  step_number: number;
  channel: string;
  action: string;
  template_id: string | null;
  schedule_mode: string;
  delay_seconds: number;
}

export interface AddStepInput {
  tenant_id: string;
  sequence_id: string;
  step_number: number;
  channel?: string;
  action?: string;
  template_id?: string;
  subject?: string;
  body?: string;
  schedule_mode?: string;
  delay_seconds?: number;
  send_mode?: string;
}

/** Add an ordered step to a sequence. */
export async function addStep(input: AddStepInput): Promise<StepRow> {
  const rows = await dataService.rows<StepRow>(
    `INSERT INTO sequence.step
       (tenant_id, sequence_id, step_number, channel, action, template_id, subject, body, schedule_mode, delay_seconds, send_mode)
     VALUES ($1,$2,$3,COALESCE($4,'email'),COALESCE($5,'send'),$6,$7,$8,COALESCE($9,'delay'),COALESCE($10,0),COALESCE($11,'individual'))
     RETURNING step_id, tenant_id, sequence_id, step_number, channel, action, template_id, schedule_mode, delay_seconds`,
    [input.tenant_id, input.sequence_id, input.step_number, input.channel ?? null, input.action ?? null,
     input.template_id ?? null, input.subject ?? null, input.body ?? null, input.schedule_mode ?? null,
     input.delay_seconds ?? null, input.send_mode ?? null],
  );
  return rows[0];
}

/* ---------------------------------------------------------------- triggers */

export interface TriggerRow {
  trigger_id: string;
  tenant_id: string;
  sequence_id: string;
  event_type: string;
  stage_id: string | null;
  trigger_on: string;
  enabled: boolean;
}

export interface CreateTriggerInput {
  tenant_id: string;
  sequence_id: string;
  event_type?: string;
  stage_id?: string;
  trigger_on?: string;
  condition_json?: Record<string, unknown>;
  enabled?: boolean;
}

/**
 * Create (or upsert) an event-based enrollment trigger. Idempotent per the
 * sequence_trigger_unique_idx (sequence, event, stage, edge).
 */
export async function createTrigger(input: CreateTriggerInput): Promise<TriggerRow> {
  const rows = await dataService.rows<TriggerRow>(
    `INSERT INTO sequence.trigger (tenant_id, sequence_id, event_type, stage_id, trigger_on, condition_json, enabled)
     VALUES ($1,$2,COALESCE($3,'stage_change'),$4,COALESCE($5,'enter'),$6::jsonb,COALESCE($7,true))
     ON CONFLICT (sequence_id, event_type, COALESCE(stage_id, '00000000-0000-0000-0000-000000000000'::uuid), trigger_on)
     DO UPDATE SET condition_json = EXCLUDED.condition_json, enabled = EXCLUDED.enabled, updated_at = now()
     RETURNING trigger_id, tenant_id, sequence_id, event_type, stage_id, trigger_on, enabled`,
    [input.tenant_id, input.sequence_id, input.event_type ?? null, input.stage_id ?? null,
     input.trigger_on ?? null, JSON.stringify(input.condition_json ?? {}), input.enabled ?? null],
  );
  return rows[0];
}

/* ------------------------------------------------------------- enrollment */

export interface EnrollInput {
  tenant_id: string;
  sequence_id: string;
  subject_persona_id: string;
  /** Optional enrollment source, e.g. 'form_submit' | 'reply' | 'stage_change' | 'manual'. */
  event_type?: string;
}

export interface EnrollResult {
  enrollment_id: string;
  sequence_id: string;
  subject_persona_id: string;
  status: string;
  already_enrolled: boolean;
  execution_step_id: string | null;
  next_run_at: string | null;
}

/**
 * Enroll a persona into a sequence. Idempotent: if the persona already has an
 * active (pending/scheduled/sending/deferred) run in this sequence, the existing
 * enrollment is returned and NO new run is scheduled. Otherwise a new enrollment
 * is created and the first step is seeded as a due execution_step for the executor.
 */
export async function enroll(input: EnrollInput): Promise<EnrollResult> {
  try {
    // Idempotency: reuse any active enrollment for this (tenant, sequence, persona).
    const existing = await dataService.one<{ enrollment_id: string; status: string }>(
      `SELECT enrollment_id, status
         FROM sequence.execution_step
        WHERE tenant_id = $1 AND sequence_id = $2 AND subject_persona_id = $3
          AND status = ANY($4)
        ORDER BY created_at ASC
        LIMIT 1`,
      [input.tenant_id, input.sequence_id, input.subject_persona_id, ACTIVE_EXEC_STATUSES],
    );
    if (existing) {
      return {
        enrollment_id: existing.enrollment_id,
        sequence_id: input.sequence_id,
        subject_persona_id: input.subject_persona_id,
        status: existing.status,
        already_enrolled: true,
        execution_step_id: null,
        next_run_at: null,
      };
    }

    // First step of the sequence drives the initial schedule.
    const firstStep = await dataService.one<{
      step_id: string; step_number: number; channel: string; action: string; delay_seconds: number;
    }>(
      `SELECT step_id, step_number, channel, action, delay_seconds
         FROM sequence.step WHERE tenant_id = $1 AND sequence_id = $2
        ORDER BY step_number ASC LIMIT 1`,
      [input.tenant_id, input.sequence_id],
    );
    if (!firstStep) {
      throw new Error('sequence has no steps to enroll into');
    }

    const enrollment_id = randomUUID();
    const dedupe_key = `${enrollment_id}:${firstStep.step_number}`;
    const row = await dataService.one<{ execution_step_id: string; next_run_at: string; status: string }>(
      `INSERT INTO sequence.execution_step
         (tenant_id, enrollment_id, sequence_id, step_id, step_number, subject_persona_id,
          channel, action, status, next_run_at, scheduled_at, dedupe_key)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'pending',
               now() + ($9 || ' seconds')::interval, now() + ($9 || ' seconds')::interval, $10)
       RETURNING execution_step_id, next_run_at, status`,
      [input.tenant_id, enrollment_id, input.sequence_id, firstStep.step_id, firstStep.step_number,
       input.subject_persona_id, firstStep.channel, firstStep.action, String(firstStep.delay_seconds), dedupe_key],
    );

    return {
      enrollment_id,
      sequence_id: input.sequence_id,
      subject_persona_id: input.subject_persona_id,
      status: row!.status,
      already_enrolled: false,
      execution_step_id: row!.execution_step_id,
      next_run_at: row!.next_run_at,
    };
  } catch (err) {
    throw new Error(`[sdk-sequence] enroll failed: ${(err as Error).message}`);
  }
}
