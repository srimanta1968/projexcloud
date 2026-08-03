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

// B2B firmographic + intent feature families (P16 EP-385). A registry addition: the
// shipped geo/field-service features and every existing endpoint are unchanged.
export {
  listB2BFeatures,
  getB2BFeature,
  registerB2BFeature,
  evaluateB2BFeatures,
  DEFAULT_B2B_WEIGHTS,
} from './services/b2bFeatures';
export type {
  B2BFeatureDef,
  B2BFeatureFamily,
  B2BSignals,
  FeatureAttribution,
  FeatureOutcome,
} from './services/b2bFeatures';
