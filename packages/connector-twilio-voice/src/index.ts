/**
 * @projexlight/connector-twilio-voice — telephony channel connector (P15·E4).
 *
 * Tracking-number provisioning, outbound call placement (statusCallback +
 * recording + answering-machine detection), and the Twilio call mirror that the
 * status/recording webhooks complete.
 *
 * Upstream I/O goes through a pluggable provider (setTwilioVoiceProvider), so the
 * package carries no twilio dependency and works unconfigured: the built-in stub
 * returns synthetic SIDs, which keeps the happy path — and the api tests — green
 * without live credentials. Same pattern as sdk-scheduling's calendar provider.
 */
import type { ConnectorAdapter, InstallRecord, ToolDefinition } from '@projexlight/sdk-connectors';
import { registerAdapter } from '@projexlight/sdk-connectors';
import { isProviderConfigured } from './provider';

export { migrationsDir } from './db';

export {
  provisionTrackingNumber,
  listTrackingNumbers,
  getTrackingNumber,
  releaseTrackingNumber,
  callbackBaseUrl,
  statusCallbackUrl,
  recordingCallbackUrl,
  NumberAlreadyProvisioned,
} from './services/numberService';

export {
  placeCall,
  getCall,
  listCalls,
  normalizeStatus,
  NoCallerIdAvailable,
  CALL_COLS,
} from './services/callService';

// Status / recording webhook ingestion + AMD -> voicemail classification (TK-3653).
export {
  verifyTwilioSignature,
  applyStatusCallback,
  applyRecordingCallback,
  normalizeAnsweredBy,
  setVoiceCallEventHandler,
} from './services/webhookService';
export type {
  StatusCallbackResult,
  RecordingCallbackResult,
  VoiceCallEventHandler,
  VoiceCallEventKind,
} from './services/webhookService';

export {
  setTwilioVoiceProvider,
  getTwilioVoiceProvider,
  isProviderConfigured,
  TwilioVoiceProviderError,
} from './provider';
export type {
  TwilioVoiceProvider,
  ProvisionNumberRequest,
  ProvisionNumberResult,
  PlaceCallRequest,
  PlaceCallResult,
} from './provider';

export {
  CALL_STATUSES,
  ANSWERED_BY_VALUES,
  VOICEMAIL_ANSWERED_BY,
  isVoicemailOutcome,
} from './models/voice.model';
export type {
  CallDirection,
  CallStatus,
  AnsweredBy,
  TrackingNumberRecord,
  VoiceCallRecord,
  ProvisionNumberInput,
  PlaceCallInput,
} from './models/voice.model';

// HTTP surface — mounted by the api-gateway.
export * as server from './server';

const TOOLS: ToolDefinition[] = [
  {
    tool_name: 'twilio-voice.number.provision',
    args_schema: { type: 'object', properties: { area_code: { type: 'string' }, purpose: { type: 'string' } }, required: [] },
    sku_required: 'connector.twilio-voice.number.provision',
    enabled_for_agents: false,
  },
  {
    tool_name: 'twilio-voice.call.place',
    args_schema: {
      type: 'object',
      properties: {
        to_number: { type: 'string' },
        from_number: { type: 'string' },
        record: { type: 'boolean' },
      },
      required: ['to_number'],
    },
    sku_required: 'connector.twilio-voice.call.place',
    enabled_for_agents: true,
  },
];

const adapter: ConnectorAdapter = {
  kind: 'twilio-voice',
  tools: TOOLS,

  async onInstall(install: InstallRecord): Promise<void> {
    // Real flow: persist the account SID / auth token via sdk-secrets and point
    // the account's voice webhooks at this gateway. Numbers are provisioned
    // on demand through provisionTrackingNumber rather than at install time.
    void install;
  },

  async onUninstall(install: InstallRecord): Promise<void> {
    // Real flow: release the install's numbers and unsubscribe webhooks. Mirror
    // rows are retained so historical calls stay attributable.
    void install;
  },

  async sync(install: InstallRecord): Promise<{ records_synced: number; conflicts: number }> {
    // Voice is push-driven: Twilio posts status/recording callbacks, so there is
    // no periodic pull. Reconciliation of missed callbacks would go here.
    void install;
    return { records_synced: 0, conflicts: 0 };
  },

  async callTool(
    install: InstallRecord,
    tool_name: string,
    args: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    if (!isProviderConfigured()) {
      return {
        ok: false,
        reason: 'connector-twilio-voice provider not configured — inject one via setTwilioVoiceProvider (TWILIO_ACCOUNT_SID/TWILIO_AUTH_TOKEN)',
      };
    }
    void install;
    void args;
    return { ok: true, tool_name, stub: true };
  },
};

registerAdapter(adapter);

export default adapter;
