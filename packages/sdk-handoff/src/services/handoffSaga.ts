import { dataService } from '@projexlight/db-runtime';
import {
  registerWorkflow,
  registerStep,
  registerCompensation,
  startRun,
  type StepContext,
} from '@projexlight/sdk-workflow';
import type { types } from '@projexlight/sdk-workflow';

type WorkflowEnvelope = types.WorkflowEnvelope;

/**
 * @projexlight/sdk-handoff — handoff saga via sdk-workflow (P15·E2, TK-3647).
 *
 * Drives the sales→delivery handoff as a durable sdk-workflow saga: kickoff → prework →
 * promises → risks → milestones, each a typed step with a compensator. On a step failure
 * the engine runs the prior steps' compensators in reverse, flipping their saga_step
 * projection to 'compensated'. No new workflow engine is introduced — registration +
 * execution + durability all come from sdk-workflow. This module only registers the
 * handoff-specific step handlers + the 'handoff.saga' definition and starts runs.
 */

export const SAGA_PHASES = ['kickoff', 'prework', 'promises', 'risks', 'milestones'] as const;
export type SagaPhase = (typeof SAGA_PHASES)[number];
const WORKFLOW_NAME = 'handoff.saga';
const NAMESPACE = 'admin';

async function recordSagaPhase(tenantId: string, handoffId: string, phase: string, runId: string | null): Promise<void> {
  await dataService.rows(
    `INSERT INTO handoff.saga_step (tenant_id, handoff_id, phase, status, run_id)
     VALUES ($1,$2,$3,'done',$4)
     ON CONFLICT (handoff_id, phase) DO UPDATE SET status = 'done', run_id = EXCLUDED.run_id, updated_at = now()`,
    [tenantId, handoffId, phase, runId],
  );
}
async function compensateSagaPhase(handoffId: string, phase: string): Promise<void> {
  await dataService.rows(
    `UPDATE handoff.saga_step SET status = 'compensated', updated_at = now()
      WHERE handoff_id = $1 AND phase = $2`,
    [handoffId, phase],
  );
}

const envVal = (ctx: StepContext, key: string): string =>
  String((ctx.envelope as Record<string, unknown>)?.[key] ?? '');

/** Build the step + compensation handler pair for one saga phase. */
function phaseHandlers(phase: SagaPhase) {
  return {
    step: async (ctx: StepContext): Promise<Record<string, unknown>> => {
      const tenantId = envVal(ctx, 'tenant_id');
      const handoffId = envVal(ctx, 'handoff_id');
      await recordSagaPhase(tenantId, handoffId, phase, ctx.run_id);
      return { phase, done: true };
    },
    comp: async (ctx: StepContext): Promise<void> => {
      await compensateSagaPhase(envVal(ctx, 'handoff_id'), phase);
    },
  };
}

let _registered = false;
/**
 * Register the handoff saga's step + compensation handlers (in-process) and, if not
 * already present, the 'handoff.saga' workflow definition. Idempotent — safe to call on
 * every gateway boot (re-registers in-process handlers; inserts the definition once).
 */
export async function registerHandoffSaga(): Promise<void> {
  for (const phase of SAGA_PHASES) {
    const { step, comp } = phaseHandlers(phase);
    registerStep(`handoff.${phase}`, step);
    registerCompensation(`handoff.${phase}.comp`, comp);
  }
  _registered = true;
  // Insert the definition only once (avoid a new version row on every respawn).
  const existing = await dataService.one<{ workflow_def_id: string }>(
    `SELECT workflow_def_id FROM workflow.definition
      WHERE name = $1 AND namespace = $2 AND status = 'active' LIMIT 1`,
    [WORKFLOW_NAME, NAMESPACE],
  ).catch(() => null);
  if (existing) return;
  await registerWorkflow({
    name: WORKFLOW_NAME,
    namespace: NAMESPACE,
    step_specs: SAGA_PHASES.map((p) => ({ name: `handoff.${p}`, compensate: `handoff.${p}.comp` })),
  }).catch((err) => console.warn('[sdk-handoff] registerHandoffSaga failed:', (err as Error).message));
}

export interface StartSagaResult {
  run_id: string;
  status: string;
  phases: string[];
}

/**
 * Start the handoff saga for a handoff. Ensures registration, then startRun drives the
 * typed steps durably (with compensation on failure). Returns the workflow run id + status.
 */
export async function startHandoffSaga(tenantId: string, handoffId: string): Promise<StartSagaResult> {
  if (!_registered) await registerHandoffSaga();
  // handoff_id rides in the envelope (persisted as JSON, reaches every step's
  // ctx.envelope — unlike run.input, which only the first step receives).
  const envelope = { tenant_id: tenantId, handoff_id: handoffId } as unknown as WorkflowEnvelope;
  const result = await startRun({
    name: WORKFLOW_NAME,
    namespace: NAMESPACE,
    envelope,
    input: { handoff_id: handoffId, tenant_id: tenantId },
  });
  return { run_id: result.run_id, status: result.status, phases: [...SAGA_PHASES] };
}

export interface SagaStepRow { phase: string; status: string; run_id: string | null; created_at: string }
/** List a handoff's saga phase projection. */
export async function listHandoffSagaSteps(tenantId: string, handoffId: string): Promise<SagaStepRow[]> {
  return dataService.rows<SagaStepRow>(
    `SELECT phase, status, run_id, created_at FROM handoff.saga_step
      WHERE tenant_id = $1 AND handoff_id = $2 ORDER BY created_at ASC`,
    [tenantId, handoffId],
  );
}
