/**
 * @projexlight/sdk-assignment — public surface.
 *
 * P7 · Auto-assignment by radius / skill / availability with territory
 * rules and workload balancing across personas. Consumed by sdk-dispatch
 * for the queue → assign → dispatch → completion loop.
 */
export { migrationsDir } from './db';
export type {
  AssignmentRef,
  TerritoryRef,
  WorkloadRef,
  AssignmentStatus,
} from '@projexlight/contracts';

// Auto-assign engine (FR-ASN-1..3 / AC-2).
export {
  assignByTask,
  acceptAssignment,
  rejectAssignment,
  completeAssignment,
  setPersonaLocationResolver,
  _resetPersonaLocationResolver,
} from './services/assignmentEngine';
export type {
  AssignByTaskInput,
  AssignByTaskResult,
  AssignStrategy,
} from './services/assignmentEngine';

// HTTP surface (EP-335) — mounted by the api-gateway; consumed by
// sdk-scheduling + lead routing so strategy selection lives in one place.
export * as server from './server';

// Territory CRUD + geofence helpers (FR-ASN-2).
export {
  createTerritory,
  listTerritories,
  findTerritoriesAt,
} from './services/territoryService';
export type { CreateTerritoryInput } from './services/territoryService';

// Workload CRUD (FR-ASN-3).
export {
  setWorkload,
  getWorkload,
  listWorkloads,
} from './services/workloadService';
export type { SetWorkloadInput } from './services/workloadService';

// Geofence helpers (point-in-polygon + haversine).
export {
  defaultGeofenceChecker,
  setGeofenceChecker,
  getGeofenceChecker,
  _resetGeofenceChecker,
  haversineKm,
} from './services/geofence';
export type { GeoPoint, GeofenceChecker } from './services/geofence';

// P16 · EP-379 — the six-step routing pipeline, its decision trace, and rules as
// versioned DATA (a routing rule changes weekly; a deploy does not).
export * from './services/routingService';

// P16 · EP-379 — ownership over time, with the source timestamp frozen.
export * from './services/lifecycleService';
