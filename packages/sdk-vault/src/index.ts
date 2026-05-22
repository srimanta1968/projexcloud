/**
 * @projexlight/sdk-vault — public surface.
 * Per ProjectStructure v3.1 §5.1, every SDK exports the same 4 surfaces.
 */
export * as client from './client';
export * as server from './server';
export * as types from './models/keyHierarchy.model';
export * as events from './events';
export { migrationsDir } from './db';
export * from './services/keyService';
export { startRotationScheduler } from './services/rotationScheduler';
export type { SchedulerConfig, SchedulerHandle } from './services/rotationScheduler';
