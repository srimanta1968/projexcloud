/**
 * @projexlight/sdk-assignment — public surface.
 *
 * P7 · Auto-assignment by radius / skill / availability with territory
 * rules and workload balancing across personas. Consumed by sdk-dispatch
 * for the queue → assign → dispatch → completion loop.
 *
 * Initial drop: Postgres migration + public-surface re-exports. Auto-assign
 * algorithm + territory geofence lookups land in follow-up tasks.
 */
export { migrationsDir } from './db';
export type {
  AssignmentRef,
  TerritoryRef,
  WorkloadRef,
  AssignmentStatus,
} from '@projexlight/contracts';
