/**
 * @projexlight/sdk-command — command & control plane for the physical-AI fleet
 * (P12 · E1). Issues commands to an asset/component, authorizing via sdk-rebac +
 * sdk-policy through pluggable hooks (the gateway wires the governance SDKs).
 */
export { migrationsDir } from './db';
export {
  issueCommand,
  getCommand,
  listCommandsByAsset,
  applyCommandApprovalDecision,
  setCommandHooks,
  classifyRisk,
  requiresApproval,
  CommandAuthorizationError,
} from './services/commandService';
export type {
  RiskClass,
  CommandStatus,
  IssueCommandInput,
  CommandRecord,
  AuthorizeContext,
  AuthorizeDecision,
  CommandHooks,
  CommandAuditEvent,
  CommandDecisionInput,
} from './services/commandService';
