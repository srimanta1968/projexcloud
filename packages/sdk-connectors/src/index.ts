export * as server from './server';
export * as types from './models/connector.model';
export { migrationsDir } from './db';
export * from './services/connectorsService';
export {
  runRetryTick,
  startSyncRetryWorker,
  reconcileSyncState,
} from './services/syncRetryWorker';
export type { RetryWorkerOptions, RetryTickResult, ReconcileResult } from './services/syncRetryWorker';
export type { ConnectorAdapter, ToolDefinition, InstallRecord } from './models/connector.model';

// Paid-social lead-form adapters (P16 EP-386).
export {
  getLeadFormAdapter,
  listLeadFormAdapters,
  LEAD_PLATFORMS,
  metaAdapter,
  linkedInAdapter,
  tiktokAdapter,
  googleAdapter,
  websiteAdapter,
  WEB_EVENT_KINDS,
} from './adapters/leadFormAdapters';
export type {
  LeadPlatform,
  LeadFormAdapter,
  NormalizedLead,
  PermissionEvidence,
  NormalizeResult,
  WebEventKind,
} from './adapters/leadFormAdapters';
export {
  ingestLeadForm,
  listLeadFormEvents,
  reprocessLeadFormEvent,
} from './services/leadFormIngest';
export type { IngestResult, IngestLeadFormInput, IngestOutcome } from './services/leadFormIngest';
