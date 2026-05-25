/**
 * @projexlight/sdk-lead-scoring — public surface.
 *
 * P7 · Per-tenant scoring model combining proximity (sdk-geo), expertise
 * (sdk-persona), intent (engagement signals), storm-impact (sdk-storm).
 * Next-best-action recommender composes with sdk-recommendation.
 */
export { migrationsDir } from './db';
export type {
  LeadScoringModelRef,
  LeadScoreRef,
  LeadScoreSubscores,
  LeadScoringFeatureWeightRef,
  LeadScoringModelStatus,
} from '@projexlight/contracts';

export {
  createModel,
  getModel,
  getActiveModel,
  activateModel,
  retireModel,
  listFeatureWeights,
  setFeatureWeight,
  DEFAULT_FEATURE_WEIGHTS,
} from './services/modelService';
export type { CreateModelInput } from './services/modelService';

export {
  scoreContact,
  nextBestAction,
  setNextBestActionResolver,
  _resetNextBestActionResolver,
} from './services/scoringEngine';
export type {
  ScoreContactInput,
  ScoreContactResult,
  RecommendedAction,
  NextBestActionResult,
} from './services/scoringEngine';

export {
  setProximityBackend,
  setExpertiseBackend,
  setIntentBackend,
  setStormImpactBackend,
  getProximityBackend,
  getExpertiseBackend,
  getIntentBackend,
  getStormImpactBackend,
  _resetLeadScoringBackends,
  DistanceDecayProximity,
  SetMembershipExpertise,
  RecencyIntent,
  ThresholdStormImpact,
} from './services/featureBackends';
export type {
  ProximityBackend,
  ExpertiseBackend,
  IntentBackend,
  StormImpactBackend,
  ProximityInput,
  ExpertiseInput,
  IntentInput,
  StormImpactInput,
} from './services/featureBackends';

export * as server from './server';
