import {
  WorkflowDefinitionMissingHandlersError,
  executeRun,
  queryRun,
  signalRun,
  StepHandlerNotFoundError,
} from './runtimeEngine';
import {
  getActiveDefinition,
  registerDefinition,
  validateStepHandlers,
} from './workflowRegistry';
import type {
  DefinitionRecord,
  QueryResult,
  RegisterDefinitionInput,
  RunRecord,
  StartRunInput,
  StartRunResult,
  StepRecord,
  WorkflowEnvelope,
} from '../models/workflow.model';

/**
 * Top-level facade per FR-WFL-1.
 *
 * Callers register a definition (durable in workflow.definition), then
 * startRun() looks up the active definition, validates that every step
 * has a registered handler in-process, then drives the runtime engine.
 *
 * Envelope propagation (FR-WFL-1): the StartRunInput.envelope is persisted
 * verbatim on workflow.run.envelope and re-exposed to each step via
 * StepContext.envelope. Steps that issue downstream SDK calls (sdk-meter,
 * sdk-audit, sdk-payment) inherit the envelope without per-step plumbing.
 */

export class WorkflowDefinitionNotFoundError extends Error {
  readonly code = 'WorkflowDefinitionNotFound';
  constructor(name: string, version?: string, namespace?: string) {
    super(
      `No active workflow definition for name='${name}'${version ? ` version='${version}'` : ''}${namespace ? ` namespace='${namespace}'` : ''}`,
    );
  }
}

export async function registerWorkflow(input: RegisterDefinitionInput): Promise<DefinitionRecord> {
  const validation = validateStepHandlers(input.step_specs);
  if (!validation.ok) {
    throw new WorkflowDefinitionMissingHandlersError(validation.missing);
  }
  return registerDefinition(input);
}

export async function startRun(input: StartRunInput): Promise<StartRunResult> {
  const def = await getActiveDefinition(input.name, input.version, input.namespace ?? 'admin');
  if (!def) throw new WorkflowDefinitionNotFoundError(input.name, input.version, input.namespace);

  const envelope: WorkflowEnvelope = input.envelope ?? {};
  const { run, steps } = await executeRun({
    definition: def,
    envelope,
    input: input.input ?? {},
  });

  return {
    run_id: run.run_id,
    status: run.status,
    steps,
    output: run.output,
  };
}

export async function getRun(run_id: string): Promise<QueryResult | null> {
  return queryRun(run_id);
}

export async function signal(
  run_id: string,
  signal_name: string,
  payload: Record<string, unknown> = {},
): Promise<void> {
  await signalRun(run_id, signal_name, payload);
}

export {
  StepHandlerNotFoundError,
  WorkflowDefinitionMissingHandlersError,
  type DefinitionRecord,
  type RunRecord,
  type StepRecord,
};
