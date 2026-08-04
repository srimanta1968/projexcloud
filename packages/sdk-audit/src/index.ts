export * as client from './client';
export * as server from './server';
export { migrationsDir } from './db';
export * as services from './services/auditService';
export { appendAuditEntry } from './services/auditService';
export type { AppendInput, LedgerEntry, ActorKind, RetentionClass } from './services/auditService';
export {
  resolveEventType,
  assertResolvableEventType,
  registerTenantEventType,
  listEventTypes,
  clearEventTypeCache,
  EventTypeRegistrationError,
} from './services/eventTypeRegistry';
export type {
  ResolvedEventType,
  EventTypeSource,
  RegisterEventTypeInput,
  RegisterEventTypeResult,
  ListedEventTypes,
} from './services/eventTypeRegistry';
export { emitEvent, addEmitTap } from './services/eventEmit';
export type { EmitEventInput, EmitTap } from './services/eventEmit';
export { startAuditVerifierScheduler, setBreakHandler, runVerifierOnce } from './services/verifierScheduler';
export type { VerifierConfig, VerifierHandle, ChainBreakEvent } from './services/verifierScheduler';
export { startRetentionShredder, runRetentionPass } from './services/retentionShredder';
export type { RetentionConfig, RetentionHandle, RetentionStats } from './services/retentionShredder';
