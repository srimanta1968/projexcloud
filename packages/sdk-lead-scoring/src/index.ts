/**
 * @projexlight/sdk-lead-scoring — public surface.
 *
 * P7 · Per-tenant scoring model combining proximity (sdk-geo), expertise
 * (sdk-persona), intent (engagement signals), storm-impact (sdk-storm).
 * Next-best-action recommender composes with sdk-recommendation.
 *
 * Initial drop: Postgres migration + public-surface re-exports. Scoring
 * engine + next-best-action recommender land in follow-up tasks.
 */
export { migrationsDir } from './db';
export type {
  LeadScoringModelRef,
  LeadScoreRef,
  LeadScoreSubscores,
  LeadScoringFeatureWeightRef,
  LeadScoringModelStatus,
} from '@projexlight/contracts';
