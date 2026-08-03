export * as server from './server';
export * as types from './models/crm.model';
export { migrationsDir } from './db';
export * from './services/crmService';
// Call/voicemail timeline activity + missed-call event (P15·E5, TK-3656).
export * from './services/callActivityService';
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

/*
 * P16 · EP-380 — the same discipline for any subject, with a refusal a client can
 * render field by field.
 *
 * Named exports rather than `export *`: the deal-scoped service already exports a
 * SaveGateResult, and a star export would make the name ambiguous and silently drop it
 * from the package surface. The subject-generic result is a DIFFERENT shape (it carries
 * a per-field missing list), so it is exported under a name that says which one it is
 * rather than shadowing the old one.
 */
export {
  ACTION_TYPES,
  setSubjectNextAction,
  getOpenSubjectNextAction,
  completeSubjectNextAction,
  checkSubjectSaveGate,
  assertSubjectSaveGate,
  validate as validateSubjectNextAction,
  SaveGateRefused,
  InvalidNextAction,
} from './services/subjectNextActionService';
export type {
  ActionType,
  SubjectNextAction,
  MissingElement,
  SetSubjectNextActionInput,
  SaveGateResult as SubjectSaveGateResult,
} from './services/subjectNextActionService';

export * from './services/overdueService';

export * from './services/closeReasonService';
