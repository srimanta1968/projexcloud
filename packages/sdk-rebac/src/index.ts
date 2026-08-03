export * as server from './server';
export * as types from './models/rebac.model';
export { migrationsDir } from './db';
export * from './services/rebacService';
export { invalidatePersona } from './services/reachabilityCache';

// Bitemporal contextual roles (P16 EP-384). Additive: existing relationship and
// role-assignment surfaces are unchanged.
export {
  grantContextualRole,
  closeContextualRole,
  listContextualRoles,
  attestContextualRole,
  requiresEvidence,
  TRUST_STATES,
  EVIDENCE_REQUIRED_STATES,
} from './services/contextualRoleService';
export type {
  ContextualRole,
  TrustState,
  GrantContextualRoleInput,
  ListRolesInput,
} from './services/contextualRoleService';
