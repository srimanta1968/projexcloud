export * as client from './client';
export * as server from './server';
export * as types from './services/poolRegistry';
export * as events from './events';
export { migrationsDir } from './db';
export { resolveTenantPool, listActivePools } from './services/poolRegistry';
export { withTenant, TenantNotFoundError } from './services/withTenant';
export type { TenantContext, TenantBoundDb } from './services/withTenant';
export { InMemoryRouteCache, setCache, getCache, getDefaultTtlMs } from './services/routeCache';
export type { RouteCache } from './services/routeCache';
export { RedisRouteCache, POOL_FLIP_CHANNEL, broadcastPoolFlip } from './services/redisRouteCache';
export { recordPoolTransition } from './services/poolLifecycle';
export type { LifecycleTransitionInput } from './services/poolLifecycle';

// P8 Variant D — Active-Active Tier-G+ profile + replication + drills.
export {
  activateProfile as activateActiveActiveProfile,
  getProfile as getActiveActiveProfile,
  listReplicationStreams,
  updateReplicationLag,
  runFailoverDrill,
  startMonthlyDrillScheduler,
  setActiveActiveEmitter,
  DEFAULT_REPLICATION_MAP,
} from './services/activeActive/profileService';
export type {
  ActivateProfileInput,
  RunFailoverDrillInput,
  DrillSchedulerConfig,
  DrillSchedulerHandle,
  ActiveActiveEmitter,
} from './services/activeActive/profileService';
export {
  resolveActiveActiveRouting,
  assertWriteAllowed as assertActiveActiveWriteAllowed,
  CrossRegionWriteRejected,
} from './services/activeActive/routingMode';
export type { RoutingDecision, RoutingContext } from './services/activeActive/routingMode';

// Y-P8-11 — replica probe loop.
export { startReplicaProbe } from './services/activeActive/replicaProbe';
export type { ReplicaProbeConfig, ReplicaProbeHandle } from './services/activeActive/replicaProbe';

// Y-P8-12 — cross-region read-replica resolver.
export { resolveReadReplica } from './services/activeActive/readReplicaResolver';
export type { ResolveReadReplicaInput, ResolvedReadReplica } from './services/activeActive/readReplicaResolver';

// Y-P8-13 — sync-commit transaction wrapper.
export { withSyncCommit, withAsyncCommit } from './services/activeActive/syncCommit';
export type { SyncCommitClient, SyncCommitMode, SyncCommitOptions } from './services/activeActive/syncCommit';
