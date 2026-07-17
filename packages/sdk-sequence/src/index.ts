/**
 * @projexlight/sdk-sequence — multi-touch cadence orchestration engine (P14·E1).
 *
 * Surface: migrationsDir (schema, TK-3612) + the definition/enrollment service &
 * Fastify routes (TK-3613). The step-executor tick loop lands with TK-3614;
 * reactive control with TK-3616; guardrails with TK-3617.
 */
export { migrationsDir } from './db';
export * as server from './server';
export * from './services/sequenceService';
export {
  runSequenceTick,
  startSequenceExecutor,
  setSequenceStepSender,
  _resetSequenceStepSender,
  nextSendableTime,
} from './services/stepExecutor';
export type {
  ExecutableStep,
  SendOutcome,
  SequenceStepSender,
  SendWindow,
  TickResult,
  ExecutorOptions,
} from './services/stepExecutor';
export {
  pauseEnrollment,
  resumeEnrollment,
  stopEnrollment,
  replaceCta,
} from './services/reactiveControl';
export type { ReactiveAction, ReactiveControlInput } from './services/reactiveControl';
export {
  checkFrequencyGuards,
  recordChannelOutcome,
  loadGuardConfig,
  upsertGuardConfig,
  listGuardLog,
} from './services/guardEngine';
export type {
  GuardConfig,
  GuardDecision,
  GuardReason,
  GuardCheckInput,
  BreakerState,
  GuardLogEntry,
} from './services/guardEngine';
