export * as client from './client';
export * as server from './server';
export { migrationsDir } from './db';
export * from './utils';
export * from './middleware';
export * from './services/identityService';
/**
 * The registration address-check seam. The gateway installs the implementation
 * (sdk-deliverability) at boot; without one, registration allows everything —
 * see the note in services/addressCheck.ts.
 */
export {
  setAddressChecker,
  resetAddressChecker,
  checkRegistrationAddress,
  emailVerificationRequired,
} from './services/addressCheck';
export type { AddressChecker, AddressCheckResult } from './services/addressCheck';
export { provisionFederationConfig } from './services/federationService';
export type { ProvisionFederationConfigInput, FederationConfigRef, FederationProtocol } from './services/federationService';
