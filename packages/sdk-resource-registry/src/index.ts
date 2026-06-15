/**
 * @projexlight/sdk-resource-registry — P10/E5 resource ownership registry.
 * No-owner-no-resource: every infra resource carries an owner + approver; the
 * GitOps reconciler quarantines orphan/expired resources and raises alerts.
 */
export * as server from './server';
export * as types from './models/resourceRegistry.model';
export { migrationsDir } from './db';
export {
  registerResource,
  getOwnership,
  reconcile,
} from './services/resourceRegistryService';
