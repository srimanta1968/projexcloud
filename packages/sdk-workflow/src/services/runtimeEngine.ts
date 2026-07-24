import { dataService } from '@projexlight/db-runtime';
import {
  getCompensationHandler,
  getStepHandler,
  StepHandlerNotFoundError,
  type StepContext,
} from './workflowRegistry';
import type {
  CompensationRecord,
  DefinitionRecord,
  QueryResult,
  RunRecord,
  StepRecord,
  StepSpec,
  WorkflowEnvelope,
} from '../models/workflow.model';

/**
 * Durable in-process runtime engine for sdk-workflow.
 *
 * v1 (migrations 001-003) executed every step inside the calling request and
 * died if the pod restarted mid-run. v2 (migration 004) makes the run row
 * itself durable:
 *
 *   - A `sleep:<duration_ms>` step name parks the run in status='paused' with
 *     wake_at = now()+ms. The polling worker (durableWorker.ts) picks it back
 *     up after the wake time elapses, even across pod restarts.
 *   - Resume picks up at workflow.run.current_idx, walking the remaining
 *     step_specs entries. The compensation chain (FR-WFL-3) is unchanged —
 *     on failure we walk every step persisted on this run in reverse.
 *   - All run.status mutations are conditional (WHERE status = expected) so
 *     two workers racing on the same run can never both claim it. The
 *     FOR UPDATE SKIP LOCKED in durableWorker.runDurableTick is the
 *     primary safety; the conditional UPDATE is belt-and-suspenders.
 *
 * The contract surfaced to workflowService.ts is identical:
 *   - executeRun() inserts the workflow.run row and immediately resumeRun()s
 *     it, so single-pod / synchronous callers still see start-to-finish in
 *     one call. If the workflow pauses, executeRun returns the paused run
 *     and the worker handles the rest.
 *   - signalRun() / queryRun() unchanged.
 */

export class WorkflowDefinitionMissingHandlersError extends Error {
  readonly code = 'WorkflowMissingHandlers';
  constructor(missing: string[]) {
    super(`Workflow definition missing step handlers: ${missing.join(', ')}`);
  }
}

export interface ExecuteRunArgs {
  definition: DefinitionRecord;
  envelope: WorkflowEnvelope;
  input: Record<string, unknown>;
}

const SLEEP_STEP_PREFIX = 'sleep:';
const RUN_SELECT_COLUMNS = `
  run_id, workflow_def_id, tenant_id, persona_id, trace_id, envelope,
  input, output, status, started_at, completed_at, error_message,
  current_idx, wake_at, claimed_by, claimed_at
`;
const STEP_SELECT_COLUMNS = `
  step_id, run_id, idx, name, status, input, output,
  started_at, completed_at, error_message, wake_at
`;

async function createRunRow(args: ExecuteRunArgs): Promise<RunRecord> {
  const rows = await dataService.rows<RunRecord>(
    `INSERT INTO workflow.run (
       workflow_def_id, tenant_id, persona_id, trace_id, envelope, input, status, current_idx
     ) VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, 'running', 0)
     RETURNING ${RUN_SELECT_COLUMNS}`,
    [
      args.definition.workflow_def_id,
      args.envelope.tenant_id ?? null,
      args.envelope.persona_id ?? null,
      args.envelope.trace_id ?? null,
      JSON.stringify(args.envelope),
      JSON.stringify(args.input),
    ],
  );
  return rows[0];
}

async function createStepRow(
  run_id: string,
  idx: number,
  spec: StepSpec,
  input: Record<string, unknown>,
): Promise<StepRecord> {
  // Idempotent by (run_id, idx): a durable resume (worker re-tick after a
  // pause/wake, or a crash-retry mid-step) can re-enter the SAME idx that a
  // prior tick already inserted. A plain INSERT violates step_run_idx_unique
  // and crash-loops the durable worker.
  //
  // CRITICAL (production, many concurrent tenants/runs): NEVER resurrect a step
  // that already SUCCEEDED — re-running its handler would repeat side effects
  // (double charge / duplicate notification). The WHERE guard makes DO UPDATE
  // reset ONLY a leftover pending/running/failed row back to 'pending'
  // (at-least-once retry — the documented contract for idempotent handlers). If
  // the conflicting row is already 'succeeded', DO UPDATE is skipped, RETURNING
  // yields nothing, and we return the existing succeeded row so the caller SKIPS
  // execution. Each run_id is unique per invocation, so different tenants/apps
  // never share a (run_id, idx) — this is purely same-run resume safety.
  const rows = await dataService.rows<StepRecord>(
    `INSERT INTO workflow.step (run_id, idx, name, input, status)
     VALUES ($1, $2, $3, $4::jsonb, 'pending')
     ON CONFLICT (run_id, idx) DO UPDATE
       SET name          = EXCLUDED.name,
           input         = EXCLUDED.input,
           status        = 'pending',
           output        = NULL,
           started_at    = NULL,
           completed_at  = NULL,
           error_message = NULL
     WHERE workflow.step.status <> 'succeeded'
     RETURNING ${STEP_SELECT_COLUMNS}`,
    [run_id, idx, spec.name, JSON.stringify(input)],
  );
  if (rows.length > 0) return rows[0];
  // Conflict row is already 'succeeded' — return it untouched; the caller
  // detects status==='succeeded' and folds its output forward without re-running.
  const existing = await dataService.one<StepRecord>(
    `SELECT ${STEP_SELECT_COLUMNS} FROM workflow.step WHERE run_id = $1 AND idx = $2`,
    [run_id, idx],
  );
  if (!existing) throw new Error(`step (${run_id}, ${idx}) upsert conflicted but row not found`);
  return existing;
}

async function markStepRunning(step_id: string): Promise<void> {
  await dataService.query(
    `UPDATE workflow.step SET status = 'running', started_at = now() WHERE step_id = $1`,
    [step_id],
  );
}

async function markStepSucceeded(step_id: string, output: Record<string, unknown>): Promise<void> {
  await dataService.query(
    `UPDATE workflow.step SET status = 'succeeded', output = $2::jsonb, completed_at = now() WHERE step_id = $1`,
    [step_id, JSON.stringify(output)],
  );
}

async function markStepFailed(step_id: string, err: Error): Promise<void> {
  await dataService.query(
    `UPDATE workflow.step SET status = 'failed', completed_at = now(), error_message = $2 WHERE step_id = $1`,
    [step_id, err.message.slice(0, 1000)],
  );
}

async function markStepCompensated(step_id: string): Promise<void> {
  await dataService.query(
    `UPDATE workflow.step SET status = 'compensated' WHERE step_id = $1`,
    [step_id],
  );
}

async function markRunFinal(
  run_id: string,
  status: 'completed' | 'failed' | 'compensated' | 'terminated',
  output: Record<string, unknown> | null,
  error?: Error,
): Promise<RunRecord> {
  // Conditional on status='running' — a paused/terminated run must not be
  // overwritten by a stale executor.
  const rows = await dataService.rows<RunRecord>(
    `UPDATE workflow.run
        SET status = $2, output = $3::jsonb, completed_at = now(), error_message = $4,
            wake_at = NULL, claimed_by = NULL, claimed_at = NULL
      WHERE run_id = $1 AND status = 'running'
      RETURNING ${RUN_SELECT_COLUMNS}`,
    [run_id, status, output ? JSON.stringify(output) : null, error?.message.slice(0, 1000) ?? null],
  );
  if (rows.length === 0) {
    // Already moved on by another worker; return current snapshot so callers
    // still get a record back.
    const snap = await dataService.one<RunRecord>(
      `SELECT ${RUN_SELECT_COLUMNS} FROM workflow.run WHERE run_id = $1`,
      [run_id],
    );
    if (!snap) throw new Error(`Run ${run_id} disappeared during markRunFinal`);
    return snap;
  }
  return rows[0];
}

async function logCompensation(
  step_id: string,
  kind: string,
  payload: Record<string, unknown>,
): Promise<CompensationRecord> {
  const rows = await dataService.rows<CompensationRecord>(
    `INSERT INTO workflow.compensation (step_id, kind, payload, status)
     VALUES ($1, $2, $3::jsonb, 'pending')
     RETURNING compensation_id, step_id, kind, payload, status, executed_at, error_message`,
    [step_id, kind, JSON.stringify(payload)],
  );
  return rows[0];
}

async function markCompensationDone(
  compensation_id: string,
  status: 'succeeded' | 'failed',
  err?: Error,
): Promise<void> {
  await dataService.query(
    `UPDATE workflow.compensation
        SET status = $2, executed_at = now(), error_message = $3
      WHERE compensation_id = $1`,
    [compensation_id, status, err?.message.slice(0, 1000) ?? null],
  );
}

function parseSleepMs(name: string): number | null {
  if (!name.startsWith(SLEEP_STEP_PREFIX)) return null;
  const tail = name.slice(SLEEP_STEP_PREFIX.length);
  const ms = Number(tail);
  if (!Number.isFinite(ms) || ms < 0) return null;
  return Math.floor(ms);
}

/**
 * Pause a running run by setting status='paused' and wake_at. The polling
 * worker (durableWorker.runDurableTick) picks it back up once wake_at <= now().
 *
 * Conditional on status='running' so a terminated/compensated run can never
 * be silently un-finalized. Returns whether the pause was applied (false
 * means the run is no longer running and the caller should stop executing).
 */
export async function pauseRun(run_id: string, wake_at: Date): Promise<boolean> {
  const rows = await dataService.rows<{ run_id: string }>(
    `UPDATE workflow.run
        SET status = 'paused', wake_at = $2, claimed_by = NULL, claimed_at = NULL
      WHERE run_id = $1 AND status = 'running'
      RETURNING run_id`,
    [run_id, wake_at],
  );
  return rows.length > 0;
}

/**
 * Resume a run from its persisted current_idx, walking the remaining steps
 * until the workflow completes, fails (with compensation), or hits another
 * sleep marker.
 *
 * Safe to call from durableWorker after FOR UPDATE SKIP LOCKED claim, and
 * also from executeRun() in the single-pod hot path.
 *
 * On entry, the run must already be in status='running' (the worker flips it
 * from 'paused' before calling). Returns the final or paused RunRecord so
 * the caller can decide whether to tally as completed/failed/resumed.
 */
export async function resumeRun(run_id: string): Promise<RunRecord> {
  const run = await dataService.one<RunRecord>(
    `SELECT ${RUN_SELECT_COLUMNS} FROM workflow.run WHERE run_id = $1`,
    [run_id],
  );
  if (!run) throw new Error(`Run ${run_id} not found`);
  if (run.status !== 'running') {
    // Worker already finalized or another pod beat us — return as-is.
    return run;
  }

  const def = await dataService.one<DefinitionRecord>(
    `SELECT workflow_def_id, name, version, namespace, step_specs, status, created_at
       FROM workflow.definition WHERE workflow_def_id = $1`,
    [run.workflow_def_id],
  );
  if (!def) {
    await markRunFinal(run_id, 'failed', null, new Error(`workflow_def_id ${run.workflow_def_id} missing`));
    return (await dataService.one<RunRecord>(
      `SELECT ${RUN_SELECT_COLUMNS} FROM workflow.run WHERE run_id = $1`,
      [run_id],
    ))!;
  }

  // Finalize any leftover sleep step rows: when we paused, we inserted a
  // status='running' row for the sleep marker and advanced current_idx
  // past it. On wake, mark those rows succeeded so the run history is
  // coherent. (We do this before hydrating prior_outputs so the sleep
  // step is reflected as completed.)
  await dataService.query(
    `UPDATE workflow.step
        SET status = 'succeeded',
            completed_at = COALESCE(completed_at, now()),
            output = COALESCE(output, input)
      WHERE run_id = $1
        AND status = 'running'
        AND name LIKE 'sleep:%'
        AND idx < $2`,
    [run_id, run.current_idx ?? 0],
  );

  // Hydrate prior_outputs from already-succeeded steps so step inputs match
  // what they'd have seen in a single-shot executeRun.
  const priorSteps = await dataService.rows<StepRecord>(
    `SELECT ${STEP_SELECT_COLUMNS}
       FROM workflow.step
      WHERE run_id = $1 AND status = 'succeeded'
      ORDER BY idx ASC`,
    [run_id],
  );
  const prior_outputs: Record<string, Record<string, unknown>> = {};
  for (const s of priorSteps) {
    if (s.output) prior_outputs[s.name] = s.output;
  }

  const specs = def.step_specs;
  const startIdx = run.current_idx ?? 0;
  let finalOutput: Record<string, unknown> = {};
  for (const [name, out] of Object.entries(prior_outputs)) finalOutput[name] = out;

  let runError: Error | undefined;
  let pausedAt: number | null = null;

  for (let idx = startIdx; idx < specs.length; idx++) {
    const spec = specs[idx];
    const sleepMs = parseSleepMs(spec.name);

    if (sleepMs !== null) {
      // Sleep marker: persist the step row as 'running' with a wake_at, then
      // pause the run. Worker picks it back up after wake_at.
      // Compute wake_at in JS so we don't depend on Postgres interval text
      // coercion semantics (which differ across versions).
      const wakeAtComputed = new Date(Date.now() + sleepMs);
      const stepRows = await dataService.rows<StepRecord>(
        `INSERT INTO workflow.step (run_id, idx, name, input, status, started_at, wake_at)
         VALUES ($1, $2, $3, $4::jsonb, 'running', now(), $5)
         ON CONFLICT (run_id, idx) DO UPDATE
           SET status     = 'running',
               started_at = COALESCE(workflow.step.started_at, now()),
               wake_at    = EXCLUDED.wake_at
         RETURNING ${STEP_SELECT_COLUMNS}`,
        [run_id, idx, spec.name, JSON.stringify({ duration_ms: sleepMs }), wakeAtComputed],
      );
      const wakeAt = (stepRows[0]?.wake_at ?? wakeAtComputed) as Date;
      // Advance the cursor PAST the sleep step. When we resume after wake,
      // we'll mark the sleep step succeeded and continue.
      await dataService.query(
        `UPDATE workflow.run SET current_idx = $2 WHERE run_id = $1 AND status = 'running'`,
        [run_id, idx + 1],
      );
      const paused = await pauseRun(run_id, wakeAt);
      if (paused) {
        pausedAt = idx;
        break;
      }
      // pause didn't apply (someone else finalized) — bail.
      return (await dataService.one<RunRecord>(
        `SELECT ${RUN_SELECT_COLUMNS} FROM workflow.run WHERE run_id = $1`,
        [run_id],
      ))!;
    }

    // Non-sleep step: handle as before.
    const stepInput: Record<string, unknown> = {
      ...(idx === 0 ? run.input : {}),
      _prior: prior_outputs,
    };

    // First, if there's a pending sleep step left over from a previous tick
    // (we paused on this idx but the worker is now past wake_at and resuming
    // on the NEXT idx — handled by current_idx already being idx+1), nothing
    // to do here. Otherwise create a fresh step row.
    const step = await createStepRow(run_id, idx, spec, stepInput);

    // Idempotent resume guard: if this idx already succeeded (a duplicate durable
    // tick or a stale current_idx re-entered a completed step), DO NOT re-run the
    // handler — fold the recorded output forward and advance. Prevents repeated
    // side effects under concurrent production load.
    if (step.status === 'succeeded') {
      const priorOut = (step.output as Record<string, unknown> | null) ?? {};
      prior_outputs[spec.name] = priorOut;
      finalOutput = { ...finalOutput, [spec.name]: priorOut };
      await dataService.query(
        `UPDATE workflow.run SET current_idx = $2 WHERE run_id = $1 AND status = 'running'`,
        [run_id, idx + 1],
      );
      continue;
    }

    const ctx: StepContext = {
      run_id,
      step_id: step.step_id,
      envelope: run.envelope,
      prior_outputs,
    };

    try {
      const handler = getStepHandler(spec.name);
      await markStepRunning(step.step_id);
      const output = await handler(ctx, stepInput);
      await markStepSucceeded(step.step_id, output);
      prior_outputs[spec.name] = output;
      finalOutput = { ...finalOutput, [spec.name]: output };
      // Advance the cursor on each successful step so a mid-walk restart
      // resumes on the next step, not the one we just finished.
      await dataService.query(
        `UPDATE workflow.run SET current_idx = $2 WHERE run_id = $1 AND status = 'running'`,
        [run_id, idx + 1],
      );
    } catch (err) {
      runError = err instanceof Error ? err : new Error(String(err));
      await markStepFailed(step.step_id, runError);
      break;
    }
  }

  if (pausedAt !== null) {
    return (await dataService.one<RunRecord>(
      `SELECT ${RUN_SELECT_COLUMNS} FROM workflow.run WHERE run_id = $1`,
      [run_id],
    ))!;
  }

  if (runError) {
    // Compensate every succeeded step on this run, in reverse, then finalize.
    const stepsToCompensate = await dataService.rows<StepRecord>(
      `SELECT ${STEP_SELECT_COLUMNS}
         FROM workflow.step
        WHERE run_id = $1
        ORDER BY idx ASC`,
      [run_id],
    );
    await runCompensations(stepsToCompensate, def, run.envelope);
    return markRunFinal(run_id, 'compensated', null, runError);
  }

  return markRunFinal(run_id, 'completed', finalOutput);
}

/**
 * Executes the workflow from a fresh insert. In single-pod mode this drives
 * the run end-to-end; if the workflow contains a sleep marker, it pauses and
 * returns — the durable worker is responsible for resuming it after wake_at.
 *
 * The returned RunRecord may therefore be 'paused' or final; callers should
 * inspect run.status rather than assume completion.
 */
export async function executeRun(args: ExecuteRunArgs): Promise<{
  run: RunRecord;
  steps: StepRecord[];
}> {
  const created = await createRunRow(args);
  const run = await resumeRun(created.run_id);
  const steps = await dataService.rows<StepRecord>(
    `SELECT ${STEP_SELECT_COLUMNS}
       FROM workflow.step
      WHERE run_id = $1
      ORDER BY idx ASC`,
    [created.run_id],
  );
  return { run, steps };
}

async function runCompensations(
  steps: StepRecord[],
  def: DefinitionRecord,
  envelope: WorkflowEnvelope,
): Promise<void> {
  // Walk completed steps in reverse order.
  for (let i = steps.length - 1; i >= 0; i--) {
    const step = steps[i];
    if (step.status !== 'succeeded') continue;
    const spec = def.step_specs[step.idx];
    if (!spec || !spec.compensate) continue;
    const handler = getCompensationHandler(spec.compensate);
    if (!handler) {
      const comp = await logCompensation(step.step_id, spec.compensate, {});
      await markCompensationDone(comp.compensation_id, 'failed', new Error('compensator not registered'));
      continue;
    }
    const comp = await logCompensation(step.step_id, spec.compensate, step.output ?? {});
    try {
      const ctx: StepContext = {
        run_id: step.run_id,
        step_id: step.step_id,
        envelope,
        prior_outputs: {},
      };
      await handler(ctx, step.output ?? {});
      await markCompensationDone(comp.compensation_id, 'succeeded');
      await markStepCompensated(step.step_id);
    } catch (err) {
      await markCompensationDone(comp.compensation_id, 'failed', err as Error);
    }
  }
}

/**
 * Read-only query API (FR-WFL-5). Returns run + every step + every
 * compensation for inspection — used by the workflow dashboard + tests.
 */
export async function queryRun(run_id: string): Promise<QueryResult | null> {
  const run = await dataService.one<RunRecord>(
    `SELECT ${RUN_SELECT_COLUMNS}
       FROM workflow.run WHERE run_id = $1`,
    [run_id],
  );
  if (!run) return null;
  const steps = await dataService.rows<StepRecord>(
    `SELECT ${STEP_SELECT_COLUMNS}
       FROM workflow.step WHERE run_id = $1 ORDER BY idx ASC`,
    [run_id],
  );
  const compensations = await dataService.rows<CompensationRecord>(
    `SELECT c.compensation_id, c.step_id, c.kind, c.payload, c.status, c.executed_at, c.error_message
       FROM workflow.compensation c
       JOIN workflow.step s ON s.step_id = c.step_id
      WHERE s.run_id = $1
      ORDER BY c.executed_at NULLS LAST`,
    [run_id],
  );
  return { run, steps, compensations };
}

/**
 * Signals an in-progress run (FR-WFL-1 hook). The synthetic engine treats
 * signals as no-op acknowledgements — production swaps for Temporal signal.
 * Persists the signal as a step row with name=`signal:<signal_name>` so the
 * query API surfaces it in run history.
 *
 * Concurrency: the (run_id, idx) UNIQUE constraint (migration 003) prevents
 * two concurrent signals from inserting at the same idx. We retry on unique
 * violation up to MAX_SIGNAL_RETRIES — each retry recomputes MAX(idx)+1, so
 * the race resolves in caller order.
 *
 * Signals are accepted while the run is running OR paused (a paused run is
 * still alive — Temporal-parity behavior).
 */
const MAX_SIGNAL_RETRIES = 5;
const UNIQUE_VIOLATION = '23505'; // SQLSTATE for unique_violation

export async function signalRun(
  run_id: string,
  signal_name: string,
  payload: Record<string, unknown>,
): Promise<void> {
  const run = await dataService.one<{ status: string }>(
    `SELECT status FROM workflow.run WHERE run_id = $1`,
    [run_id],
  );
  if (!run) throw new Error(`Run ${run_id} not found`);
  if (run.status !== 'running' && run.status !== 'paused') {
    throw new Error(`Run ${run_id} not in running/paused state; cannot signal`);
  }

  for (let attempt = 0; attempt < MAX_SIGNAL_RETRIES; attempt++) {
    try {
      await dataService.query(
        `INSERT INTO workflow.step (run_id, idx,
           name, input, status, started_at, completed_at, output)
         SELECT $1,
                COALESCE((SELECT MAX(idx) + 1 FROM workflow.step WHERE run_id = $1), 0),
                $2, $3::jsonb, 'succeeded', now(), now(), $3::jsonb`,
        [run_id, `signal:${signal_name}`, JSON.stringify(payload)],
      );
      return;
    } catch (err) {
      const code = (err as { code?: string }).code;
      if (code === UNIQUE_VIOLATION && attempt < MAX_SIGNAL_RETRIES - 1) {
        // concurrent signal won the idx race — retry to compute the next one.
        continue;
      }
      throw err;
    }
  }
  throw new Error(`signalRun: exceeded ${MAX_SIGNAL_RETRIES} retries due to concurrent idx collisions`);
}

export { StepHandlerNotFoundError };
