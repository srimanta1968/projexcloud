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

// P8 Variant A — BYOK / CMEK.
export {
  bindCmk,
  rotateCmk,
  revokeCmk,
  unwrapTenantKey,
  UndecryptableError,
  _resetByokCache,
  getBinding as getByokBinding,
  getBindingForTenant as getByokBindingForTenant,
  recordCmkUse,
  setByokEmitter,
  setSiemForwarder,
} from './services/byok/byokService';
export type {
  BindCmkInput,
  RotateCmkInput,
  RevokeCmkInput,
  RecordCmkUseInput,
  CmkUseEmitter,
  SiemForwarder,
} from './services/byok/byokService';
export {
  registerAwsKmsProvider,
  registerGcpKmsProvider,
  registerHsmPkcs11Provider,
  registerSyntheticProvidersForDev,
  getProvider as getKmsProvider,
  SyntheticKmsProvider,
} from './services/byok/providers';
export type { KmsProvider } from './services/byok/providers';
export {
  AwsKmsRealProvider,
  GcpKmsRealProvider,
  HsmPkcs11RealProvider,
  registerRealKmsProvidersFromEnv,
} from './services/byok/realProviders';
export {
  installByokInvalidator,
  broadcastInvalidate as broadcastByokInvalidate,
  BYOK_INVALIDATE_CHANNEL,
} from './services/byok/redisInvalidation';
export {
  installAutoSiemForwarder,
  splunkHecForwarder,
  elasticForwarder,
  sumoForwarder,
  detectSiemKind,
} from './services/byok/siemForwarders';
export type { SiemKind } from './services/byok/siemForwarders';
