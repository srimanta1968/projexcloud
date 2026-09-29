/**
 * @projexlight/sdk-dialer — outbound call dispatch for voice agents (VA·E5).
 *
 * Owns campaigns and their contacts, the dispatch queue, and the gate chain every
 * outbound AI call passes (consent, DNC, calling window, recording jurisdiction,
 * concurrency caps) — for a campaign contact and a single API call alike, so the
 * compliance rules live in one place instead of in each consuming app.
 * See docs/v3.1/voiceagent/VoiceAgent-Architecture-v3.1.html.
 */
export { migrationsDir } from './db';

export { DialerError } from './models/errors';

export {
  CAMPAIGN_STATUSES,
  CONTACT_STATUSES,
  VOICEMAIL_POLICIES,
  createCampaign,
  getCampaign,
  listCampaigns,
  transitionCampaign,
  upsertContacts,
  listContacts,
  publishProgress,
  isValidTimezone,
} from './services/campaignService';
export type {
  Campaign,
  CampaignAction,
  CampaignContact,
  CampaignProgress,
  CampaignStatus,
  ContactInput,
  ContactStatus,
  CreateCampaignInput,
  UpsertContactsResult,
  VoicemailPolicy,
} from './services/campaignService';

export { registerGate, listGates, runGateChain } from './services/gateChain';
export type { Gate, GateContext, GateResult, GateVerdict, ChainOutcome } from './services/gateChain';
export { dispatchCall, dialContact } from './services/dispatchService';
// Registers the dnc + consent gates on the shared chain as a side effect of loading.
export {
  VOICE_CONSENT_PURPOSE,
  CALL_RECORDING_PURPOSE,
  countryOfNumber,
  consentJurisdiction,
  ensureVoiceConsentPurposes,
} from './services/complianceGates';
// Registers the calling_window + recording gates as a side effect of loading.
export { localHHMM, nextWindowOpening, recordingRuleFor } from './services/windowRecordingGates';
export type { RecordingRule } from './services/windowRecordingGates';

// HTTP surface — mounted by the api-gateway.
export * as server from './server';
