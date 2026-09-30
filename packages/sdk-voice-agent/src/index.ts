/**
 * @projexlight/sdk-voice-agent — control plane for multi-tenant BYOK voice agents (VA·E2).
 *
 * Owns stack profiles (cloned from presets), agents and their immutable versions,
 * number bindings, app-registered tools, AI call records and turn transcripts.
 * The real-time media runtime lives in services/voice-runtime and reads this
 * control plane once per call; see docs/v3.1/voiceagent/VoiceAgent-Architecture-v3.1.html.
 */
export { migrationsDir } from './db';

export { VOICE_LAYERS, PRESET_KEYS, VOICE_PRESETS, findPreset, isVoiceLayer } from './models/presets';
export type { VoiceLayer, PresetKey, LayerConfig, LayerMap, VoicePreset } from './models/presets';
export { VoiceAgentError } from './models/errors';

export {
  createStackProfile,
  listStackProfiles,
  getStackProfile,
  updateStackProfile,
  archiveStackProfile,
  setCredentialChecker,
  listPresetsWithCertification,
  estimateStackProfileCost,
} from './services/stackProfileService';
export type {
  StackProfile,
  LayerCertification,
  PresetWithCertification,
  CredentialRef,
  CredentialRefs,
  LayerOverrides,
  LayerFallbacks,
  CreateStackProfileInput,
  UpdateStackProfileInput,
  CredentialChecker,
  InvalidCredentialRef,
} from './services/stackProfileService';

export {
  AGENT_DIRECTIONS,
  VERSION_APPROVAL_SUBJECT_KIND,
  createAgent,
  getAgent,
  listAgents,
  createVersion,
  getVersion,
  listVersions,
  recordEvalRun,
  requestPublishApproval,
  publishVersion,
  rollbackAgent,
} from './services/agentService';
export type {
  Agent,
  AgentVersion,
  AgentDirection,
  AgentStatus,
  EvalRun,
  CreateAgentInput,
  CreateVersionInput,
  RecordEvalRunInput,
} from './services/agentService';

export {
  CARRIERS,
  FALLBACKS,
  bindNumber,
  listNumbers,
  unbindNumber,
  resolveInboundNumber,
  setKillSwitch,
} from './services/numberService';
export type { Carrier, Fallback, NumberBinding, BindNumberInput, InboundRoute, KillSwitchState } from './services/numberService';

export { registerTool, listTools, getTool, updateTool, effectiveTools, callSessionContext, toolSigningSecret } from './services/toolService';
export { RUNTIME_LAYERS, bootstrapRuntimeSession, setSessionTokenMinter, setRecordingRuleResolver, setInboundAdmitter } from './services/bootstrapService';
export type { BootstrapInput, RuntimeBootstrap, RuntimeFallback, RuntimeLayer, RuntimeLayerConfig, RuntimeTool, KeyHandle, SessionTokenGrant, SessionTokenMinter, TierRoute, RecordingDecision, RecordingRuleResolver, InboundAdmitter } from './services/bootstrapService';
export type { CallSessionContext } from './services/toolService';
export type { AppTool, RegisterToolInput, UpdateToolInput } from './services/toolService';

export { CALL_STATUSES, CALL_DIRECTIONS, placeCall, getCall, listCalls, setCallDispatcher } from './services/callService';

export { VOICE_DISPOSITIONS, completeCall, setCallSummarizer, onCallEnded } from './services/postCallService';
export type { CallEndedListener } from './services/postCallService';
export { startTestSession } from './services/testSessionService';
export { authorizeLiveView, issueLiveTicket, redeemLiveTicket, appendLiveTurns } from './services/liveService';
export type { LiveViewer, LiveTicket } from './services/liveService';
export { getLiveCallBroker } from './services/liveBroker';
export type { LiveEvent, LiveEventKind, LiveSubscriber } from './services/liveBroker';
export type { StartTestSessionInput, TestSession } from './services/testSessionService';
export { liveKitConfig, signParticipantToken } from './services/livekitToken';
export { carrierSignalingAddresses, isAddressOrCidr } from './services/carrierAllowlist';
export type { LiveKitConfig, ParticipantTokenInput } from './services/livekitToken';
export type { VoiceDisposition, CompleteCallInput, TurnInput, CallSummary, CallSummarizer } from './services/postCallService';
export type {
  Call,
  CallDetail,
  CallTurn,
  CallStatus,
  CallDirection,
  CallDispatcher,
  PlaceCallInput,
  PlaceCallOptions,
  PlaceCallResult,
  ListCallsFilter,
} from './services/callService';

// HTTP surface — mounted by the api-gateway.
export {
  provisionTwilioTrunk,
  provisionTrunk,
  registerCarrierProvisioner,
  provisionableCarriers,
  listTrunks,
  getTrunk,
  syncTrunkNumbers,
  deleteTrunk,
  originateCall,
  setOutboundNumberSource,
} from './services/telephonyService';
export type { SipTrunk, ProvisionResult, OriginationResult, OutboundNumberSource, CarrierProvisioner, CarrierProvisionInput, CarrierProvisionResult } from './services/telephonyService';
export { linkCarrierCall, applyCarrierStatus } from './services/carrierStatusService';
export type { CarrierStatusInput, CarrierStatusResult } from './services/carrierStatusService';
export * as server from './server';
