/**
 * @projexlight/sdk-meter — public barrel.
 *
 * Re-exports the two-phase metering gate (check + report), the pricing-catalog
 * lookup helpers, the `@meter()` decorator metadata registry, the per-tenant
 * chain verifier, and the verifier-scheduler background worker. Every public
 * surface ships a typed export — types come from the modules below and are
 * surfaced here for downstream consumers.
 */
export * as client from './client';
export * as server from './server';
export * as types from './services/meterGate';
export * as events from './events';
export { migrationsDir } from './db';
export {
  check,
  report,
  setEmitter,
  registerSoftCapResolver,
  registerHardCapResolver,
  registerCurrentUsageResolver,
  getMeterMode,
} from './services/meterGate';
export type {
  UsageEventV1,
  MeterDimensions,
  GateDecision,
  ReportInput,
  GateCheckResult,
  SoftCapResolver,
  HardCapResolver,
  CurrentUsageResolver,
  MeterMode,
} from './services/meterGate';
export { recordQuotaDenial } from './services/quotaDenial';
export type { RecordDenialInput, DenialRow } from './services/quotaDenial';
export {
  reportRobotUsage,
  meterSensorReadings,
  meterRobotCommand,
  meterRobotActiveHours,
  getRobotUsage,
  ROBOT_SKU,
} from './services/robotMeter';
export type { RobotUsageInput, RobotUsageRow } from './services/robotMeter';
export { applyHardCapOverride } from './services/hardCapOverride';
export type { ApplyHardCapOverrideInput, HardCapOverrideResult } from './services/hardCapOverride';
export {
  listPricingCatalogs,
  getPricingCatalog,
  upsertPricingRate,
  createCatalogVersion,
  setCatalogStatus,
} from './services/catalogAdmin';
export type {
  CatalogRow,
  RateRow,
  CatalogStatus,
  UpsertRateInput,
  CreateCatalogVersionInput,
} from './services/catalogAdmin';
export { installSoftCapHook } from './services/softCapMiddleware';
export type { InstallSoftCapsOptions } from './services/softCapMiddleware';
export {
  installRedisUsageCounter,
  registerUsageCounter,
  getUsageCounter,
  InMemoryUsageCounter,
} from './services/usageCounter';
export type { UsageCounter } from './services/usageCounter';
export { lookupRate, listActiveRates } from './services/pricingCatalog';
export type { PricingRate, PricingUnit, PricingMode } from './services/pricingCatalog';
export { meter, registerMeterMetadata, getMeterMetadata, listMeterMetadata } from './decorators';
export type { MeterMetadata } from './decorators';
export { verifyMeterChain, verifyAllMeterChains } from './services/chainVerifier';
export type { MeterChainProof, MeterChainBreak } from './services/chainVerifier';
export { startMeterVerifierScheduler, setMeterBreakHandler } from './services/verifierScheduler';
export type { MeterVerifierConfig, MeterVerifierHandle } from './services/verifierScheduler';

// Y-P8-15 — P8 NFR SLO alarms.
export {
  startSloAlarms,
  runSloEvaluation,
  setSloAlarmEmitter,
  SLO_RULES,
} from './services/sloAlarms';
export type {
  SloRuleId,
  SloRule,
  SloAlarmEmitter,
  SloEvaluation,
  SloAlarmsConfig,
  SloAlarmsHandle,
} from './services/sloAlarms';
