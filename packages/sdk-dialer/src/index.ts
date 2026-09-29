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

// HTTP surface — mounted by the api-gateway.
export * as server from './server';
