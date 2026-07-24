import { dataService } from '@projexlight/db-runtime';
import type {
  DefinitionRecord,
  RegisterDefinitionInput,
  StepSpec,
  WorkflowEnvelope,
} from '../models/workflow.model';

/**
 * Workflow definition registry per FR-WFL-2.
 *
 * Two parallel registrations:
 *   1. workflow.definition row — durable record of every (name, version, namespace)
 *   2. In-process function registry — maps (name, version) → typed handlers
 *      for `step.name` and `compensate.kind`. Production deploys load these
 *      at boot via importing the workflow module that calls registerStep().
 *
 * The DB row alone isn't enough to run a workflow — the runtime needs the
 * actual TypeScript handlers, which is why we keep an in-process map. When
 * a run starts, we look up the handler by step name; missing handler is a
 * deploy-config error surfaced as run status='failed'.
 */

export class StepHandlerNotFoundError extends Error {
  readonly code = 'StepHandlerNotFound';
  constructor(name: string) { super(`No step handler registered for '${name}'`); }
}

export type StepHandler<TIn = Record<string, unknown>, TOut = Record<string, unknown>> = (
  ctx: StepContext,
  input: TIn,
) => Promise<TOut>;

export type CompensationHandler = (
  ctx: StepContext,
  payload: Record<string, unknown>,
) => Promise<void>;

export interface StepContext {
  run_id: string;
  step_id: string;
  envelope: WorkflowEnvelope;
  /** Output of every prior succeeded step, keyed by step.name. */
  prior_outputs: Record<string, Record<string, unknown>>;
}

const stepHandlers = new Map<string, StepHandler>();
const compensationHandlers = new Map<string, CompensationHandler>();

/**
 * Register a step handler. Production code typically calls this at module
 * import time so the handler is available before any run starts.
 */
export function registerStep<TIn = Record<string, unknown>, TOut = Record<string, unknown>>(
  name: string,
  handler: StepHandler<TIn, TOut>,
): void {
  stepHandlers.set(name, handler as StepHandler);
}

export function registerCompensation(kind: string, handler: CompensationHandler): void {
  compensationHandlers.set(kind, handler);
}

export function getStepHandler(name: string): StepHandler {
  const h = stepHandlers.get(name);
  if (!h) throw new StepHandlerNotFoundError(name);
  return h;
}

export function getCompensationHandler(kind: string): CompensationHandler | undefined {
  return compensationHandlers.get(kind);
}

/* --------------------------------------------------------- DB-side registry */

export async function registerDefinition(input: RegisterDefinitionInput): Promise<DefinitionRecord> {
  const rows = await dataService.rows<DefinitionRecord>(
    `INSERT INTO workflow.definition (name, version, namespace, step_specs)
     VALUES ($1, $2, $3, $4::jsonb)
     ON CONFLICT (name, version, namespace) DO UPDATE
       SET step_specs = EXCLUDED.step_specs,
           status     = 'active'
     RETURNING workflow_def_id, name, version, namespace, step_specs, status, created_at`,
    [
      input.name,
      input.version ?? '1.0.0',
      input.namespace ?? 'admin',
      JSON.stringify(input.step_specs),
    ],
  );
  return rows[0];
}

export async function getActiveDefinition(
  name: string,
  version?: string,
  namespace = 'admin',
): Promise<DefinitionRecord | null> {
  if (version) {
    return dataService.one<DefinitionRecord>(
      `SELECT workflow_def_id, name, version, namespace, step_specs, status, created_at
         FROM workflow.definition
        WHERE name = $1 AND version = $2 AND namespace = $3 AND status = 'active'`,
      [name, version, namespace],
    );
  }
  return dataService.one<DefinitionRecord>(
    `SELECT workflow_def_id, name, version, namespace, step_specs, status, created_at
       FROM workflow.definition
      WHERE name = $1 AND namespace = $2 AND status = 'active'
      ORDER BY version DESC
      LIMIT 1`,
    [name, namespace],
  );
}

/**
 * Returns the step_specs for a definition, ensuring the registered TS
 * handlers exist for every step. Returns missing handler names so deploy
 * can fail-fast on misconfigured workflows.
 */
export function validateStepHandlers(specs: StepSpec[]): { ok: boolean; missing: string[] } {
  const missing: string[] = [];
  for (const spec of specs) {
    // `sleep:<ms>` is an engine-intrinsic pause step handled by the runtime
    // (runtimeEngine.parseSleepMs / pauseRun), not a registered TS handler.
    // The validator must mirror that or it rejects a valid definition.
    if (spec.name.startsWith('sleep:')) continue;
    if (!stepHandlers.has(spec.name)) missing.push(spec.name);
  }
  return { ok: missing.length === 0, missing };
}
