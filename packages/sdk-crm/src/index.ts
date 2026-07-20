export * as server from './server';
export * as types from './models/crm.model';
export { migrationsDir } from './db';
export * from './services/crmService';
export * from './services/nextActionService';
export {
  checkStageTransition,
  guardedTransition,
  setStageTransitionMap,
  setStageCriteriaHook,
  StageTransitionError,
  DEFAULT_TRANSITIONS,
} from './services/stageGuardService';
export type { StageGuardResult, StageCriteriaHook } from './services/stageGuardService';
