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
  dispatchCommand,
  dispatchApprovedCommands,
  recordAck,
  startCommandDispatcher,
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
  AckInput,
} from './services/commandService';
export { getCommandBroker } from './services/commandBroker';
export type { CommandDeliveryEvent, CommandSubscriber } from './services/commandBroker';
export {
  issueRobotCredential,
  verifyRobotCredential,
  assetScope,
  COMMAND_ACK_SCOPE,
  COMMAND_STREAM_SCOPE,
} from './services/commandCreds';
export type {
  IssueRobotCredentialInput,
  RobotCredential,
  VerifyRobotCredentialResult,
} from './services/commandCreds';
