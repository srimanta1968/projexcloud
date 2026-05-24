/**
 * @projexlight/sdk-agent-runtime — public surface.
 *
 * Phase P6A · Wave W6 first half. Closes Gate G7 by shipping the four agent
 * isolation primitives (capability tokens, execution TTL, deterministic
 * replay, sandboxed memory) plus tool permission boundaries and scope-
 * exception routing.
 */
export { migrationsDir } from './db';
export * as server from './server';

// Capability tokens (FR-ART-1..4 / AC-3) — TK-3284.
export {
  mintToken,
  validateToken,
  markTokenUsed,
  revokeToken,
  isRevoked,
} from './services/capabilityTokenIssuer';
export type {
  MintInput,
  MintedToken,
  ValidateResult,
  ValidateRejectReason,
  RevokeInput,
} from './services/capabilityTokenIssuer';

// Signing key loader + test hook.
export { getCurrentSigningKey, resetSigningKeyCache } from './services/signingKey';

// Action journal + rollback engine (AC-8 / FR-ART-20) — TK-3300/3301.
export {
  appendJournalEntry,
  rollbackRun,
  registerCompensationHandler,
  unregisterCompensationHandler,
} from './services/actionJournal';
export type {
  JournalAppendInput,
  JournalEntry,
  CompensationHandler,
  CompensationContext,
  RollbackInput,
  RollbackSummary,
  RollbackStepResult,
} from './services/actionJournal';

// Execution log + deterministic replay engine (FR-ART-8..12 / AC-5) — TK-3277.
export {
  appendLogEntry,
  readLog,
  readLogWithEnvelopes,
  hashPayload,
} from './services/executionLog';
export type {
  AppendLogEntryInput,
  LogEntry,
  ExecutionLogKind as ExecutionLogStepKind,
} from './services/executionLog';

export { replayRun, registerReplayer } from './services/replayEngine';
export type {
  ReplayVerdict,
  ReplayOptions,
  Replayer,
  ReplayContext,
  ReplayStepInput,
  ReplayStepResult,
  ReplayStepKind,
} from './services/replayEngine';

// Agent definition CRUD + chain provenance (FR-ART-17..18) — TK-3282.
export {
  createAgentDefinition,
  getAgentDefinition,
  listAgentDefinitions,
  resolveAgentChain,
} from './services/agentDefinitionService';
export type {
  AgentDefinition,
  CreateAgentDefinitionInput,
  ListAgentDefinitionsInput,
  AgentTier,
} from './services/agentDefinitionService';

// Agent run lifecycle (TK-3283).
export {
  startAgentRun,
  getAgentRun,
  listAgentRuns,
} from './services/agentRunLifecycle';
export type {
  AgentRun,
  AgentRunStatus,
  StartRunInput,
  ListRunsInput,
} from './services/agentRunLifecycle';

// Tool-manifest enforcement + scope-exception routing (FR-ART-21..23 / AC-7,9) — TK-3281.
export {
  enforceToolManifest,
  resolveScopeException,
  ScopeViolationError,
} from './services/scopeEnforcement';
export type {
  EnforceInput,
  EnforceResult,
  ResolveExceptionInput,
} from './services/scopeEnforcement';

// Vector namespace isolation check (FR-ART-13..16 / AC-6) — TK-3279.
export {
  assertVectorNamespaceIsolation,
  checkVectorNamespaceIsolation,
  registerNamespaceProbe,
} from './services/vectorNamespaceCheck';
export type {
  VectorBackend,
  NamespaceRegistryRow,
  NamespaceProbe,
  NamespaceProbeResult,
  NamespaceCheckReport,
  NamespaceCheckIssue,
  AssertOptions,
} from './services/vectorNamespaceCheck';

// Execution TTL enforcer (FR-ART-5..7 / AC-4) — TK-3276.
export {
  startTtlEnforcer,
  registerCancellationHook,
  unregisterCancellationHook,
  registerRefundHook,
} from './services/ttlEnforcer';
export type {
  TtlEnforcerConfig,
  TtlEnforcerHandle,
  CancellationHook,
  RefundHook,
  RefundInput,
} from './services/ttlEnforcer';

// Execution-log retention worker (G-10 / FR-ART-11) — TK-3310.
export { startLogRetentionWorker } from './services/logRetentionWorker';
export type {
  LogRetentionConfig,
  LogRetentionHandle,
  PurgeResult,
} from './services/logRetentionWorker';

// Capability-token signing key rotation (G-11 / R-2) — TK-3311.
export { startSigningKeyRotation } from './services/signingKeyRotation';
export type {
  SigningKeyRotationConfig,
  SigningKeyRotationHandle,
  RotationResult,
} from './services/signingKeyRotation';
