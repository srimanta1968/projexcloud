/**
 * @projexlight/sdk-recommendation — public surface.
 *
 * P6B · Similar-X · next-best-action recommender. Per-tenant model
 * artifacts (vector-isolated). A/B variants via sdk-feature-flags.
 *
 * Initial drop: Postgres migration + contracts. Full trainModel /
 * suggest / recordFeedback executors land in follow-up tasks under
 * feat_recommendation.
 */
export { migrationsDir } from './db';
