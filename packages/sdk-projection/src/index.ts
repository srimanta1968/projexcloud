export * as types from './models/subjectView.model';
export { migrationsDir } from './db';

// Fastify surface — mounted by the api-gateway via app.register(projectionServer.registerRoutes).
export * as server from './server';

// Attribute survivorship + explained projection (P16 EP-382).
export {
  resolveSurvivorshipRules,
  listSurvivorshipRules,
  putSurvivorshipRules,
  deleteSurvivorshipRules,
  validateCriteria,
  BUILTIN_CRITERIA,
} from './services/survivorshipRuleService';
export type {
  SurvivorshipCriterion,
  SurvivorshipRuleSet,
  CriterionName,
} from './services/survivorshipRuleService';

export {
  explainProjection,
  listAssertions,
  recordAssertion,
  retractAssertion,
} from './services/explainedProjectionService';
export type {
  ExplainedProjection,
  ExplainedAttribute,
  LosingAssertion,
  AssertionRecord,
  ExplainProjectionInput,
  RecordAssertionInput,
} from './services/explainedProjectionService';
export * from './services/subjectViewService';
export { enqueueProjectionRefresh, enqueueTenantRefresh } from './services/inboxEnqueue';
export type { ProjectionTouchInput } from './services/inboxEnqueue';
export {
  PROJECTION_REFRESH_CHANNEL,
  PROJECTION_INVALIDATE_CHANNEL,
  type ProjectionRefreshedMessage,
  type SubjectViewRecord,
  type ProjectSubjectInput,
} from './models/subjectView.model';

// Deterministic replay (P16 EP-382) — rebuild from the assertion log, never patch.
export {
  replaySubject,
  replayTenant,
  retractAndReplay,
  supersedeAndReplay,
  getReplaySnapshot,
  hashProjection,
  canonicalizeProjection,
} from './services/replayService';
export type { ReplayResult, ReplayTrigger, ReplaySubjectInput } from './services/replayService';
