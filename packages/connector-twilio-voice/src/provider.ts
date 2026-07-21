import { randomUUID } from 'crypto';

/**
 * Pluggable Twilio Voice provider (P15·E4).
 *
 * The connector never imports the twilio SDK or talks to the network directly.
 * The host app injects a real provider via setTwilioVoiceProvider(); the default
 * is a no-op stub that returns synthetic SIDs, so the happy path works — and the
 * api tests pass — without live Twilio credentials or a paid account.
 *
 * This is the same provider-hook pattern used by sdk-scheduling's calendar
 * provider and sdk-deliverability's IMAP fetcher.
 */

export interface ProvisionNumberRequest {
  phone_number?: string | null;
  area_code?: string | null;
  friendly_name?: string | null;
  /** Where Twilio should POST inbound-call and status events for this number. */
  voice_url?: string | null;
  status_callback_url?: string | null;
}
export interface ProvisionNumberResult {
  /** Twilio IncomingPhoneNumber SID. */
  sid: string;
  phone_number: string;
  capabilities?: Record<string, unknown>;
}

export interface PlaceCallRequest {
  to: string;
  from: string;
  /** Twilio posts call-progress events here (initiated/ringing/answered/completed). */
  status_callback_url: string;
  /** Twilio posts the recording here once it is ready. */
  recording_status_callback_url?: string | null;
  record: boolean;
  machine_detection: boolean;
}
export interface PlaceCallResult {
  /** Twilio Call SID. */
  sid: string;
  status?: string;
}

export interface TwilioVoiceProvider {
  provisionNumber(req: ProvisionNumberRequest): Promise<ProvisionNumberResult>;
  placeCall(req: PlaceCallRequest): Promise<PlaceCallResult>;
  releaseNumber(sid: string): Promise<void>;
}

/** Thrown when the injected provider fails; surfaced as 422 + remediation. */
export class TwilioVoiceProviderError extends Error {
  constructor(message: string, public remediation?: string) {
    super(`[connector-twilio-voice] ${message}`);
    this.name = 'TwilioVoiceProviderError';
  }
}

const stubProvider: TwilioVoiceProvider = {
  async provisionNumber(req) {
    // A deterministic-looking but unique synthetic number keeps the unique index
    // honest across repeated test runs.
    const suffix = String(Math.abs(hashCode(randomUUID()))).padStart(7, '0').slice(0, 7);
    return {
      sid: `PNstub${randomUUID().replace(/-/g, '').slice(0, 26)}`,
      phone_number: req.phone_number || `+1${req.area_code ?? '555'}${suffix}`,
      capabilities: { voice: true, sms: false, stub: true },
    };
  },
  async placeCall() {
    return { sid: `CAstub${randomUUID().replace(/-/g, '').slice(0, 26)}`, status: 'queued' };
  },
  async releaseNumber() {
    /* no-op for the stub */
  },
};

function hashCode(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
  return h;
}

let _provider: TwilioVoiceProvider = stubProvider;

/** Inject the live Twilio client (host app wires this at boot). */
export function setTwilioVoiceProvider(provider: TwilioVoiceProvider): void {
  _provider = provider;
}
export function getTwilioVoiceProvider(): TwilioVoiceProvider {
  return _provider;
}
/** Restore the stub (tests). */
export function _resetTwilioVoiceProvider(): void {
  _provider = stubProvider;
}

/** True when a real provider has been injected (i.e. not the built-in stub). */
export function isProviderConfigured(): boolean {
  return _provider !== stubProvider;
}
