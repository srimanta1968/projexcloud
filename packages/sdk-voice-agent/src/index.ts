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
} from './services/stackProfileService';
export type {
  StackProfile,
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

export { registerTool, listTools, getTool, updateTool, effectiveTools } from './services/toolService';
export type { AppTool, RegisterToolInput, UpdateToolInput } from './services/toolService';

export { CALL_STATUSES, CALL_DIRECTIONS, placeCall, getCall, listCalls, setCallDispatcher } from './services/callService';
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
export * as server from './server';
