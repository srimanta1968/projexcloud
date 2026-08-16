export * as server from './server';
export * as types from './models/identityContext.model';
export * from './services/resolverService';
export { migrationsDir } from './db';
// P10/E6 — Healthcare EMPI / probabilistic MDM.
export * from './services/empiService';
// Traits in, a person or a steward case out — the operation the capability
// manifest has always described. Exported for in-process callers too, since
// most consumers in this monorepo should not be going over HTTP to reach it.
export { resolveTraits } from './services/matchService';
export type { ResolveTraitsInput, ResolveTraitsResult } from './services/matchService';
export {
  scoreMatch,
  DEFAULT_WEIGHTS as EMPI_DEFAULT_WEIGHTS,
} from './services/fieldMatch';
export type { MatchableIdentity, MatchWeights, MatchResult } from './services/fieldMatch';
