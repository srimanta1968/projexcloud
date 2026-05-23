// Real Twilio SMS adapter implementing the ProviderAdapter contract from
// providerAdapters.ts. Replaces the synthetic 'twilio' stub for the 'sms' channel.
//
// Env vars (must be present for register*Adapter() to wire this in):
//   TWILIO_ACCOUNT_SID
//   TWILIO_AUTH_TOKEN
// And one of:
//   TWILIO_MESSAGING_SERVICE_SID  (preferred — supports A2P 10DLC pools / failover)
//   TWILIO_FROM_NUMBER            (single sender, E.164)
//
// On Twilio errors we rethrow so the failover chain in sendWithFailover()
// can advance to the next registered provider for the 'sms' channel.

import {
  registerAdapter,
  type ProviderAdapter,
  type SendArgs,
  type SendResult,
} from './providerAdapters';

// Twilio SDK is loaded lazily so the package can be imported in environments
// where twilio isn't installed (e.g. when only email channels are used and
// the dep was pruned). We keep the require behind a function and cache it.
type TwilioMessageCreate = (opts: {
  to: string;
  body: string;
  from?: string;
  messagingServiceSid?: string;
}) => Promise<{ sid: string; status?: string }>;

interface TwilioClient {
  messages: { create: TwilioMessageCreate };
}

let cachedClient: TwilioClient | null = null;

function getClient(): TwilioClient {
  if (cachedClient) return cachedClient;
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  if (!sid || !token) {
    throw new Error('twilioSmsAdapter: TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN must be set');
  }
  const twilio = require('twilio') as (sid: string, token: string) => TwilioClient;
  cachedClient = twilio(sid, token);
  return cachedClient;
}

export const twilioSmsAdapter: ProviderAdapter = {
  provider: 'twilio',
  channel: 'sms',
  async send(args: SendArgs): Promise<SendResult> {
    const messagingServiceSid = process.env.TWILIO_MESSAGING_SERVICE_SID;
    const from = process.env.TWILIO_FROM_NUMBER;
    if (!messagingServiceSid && !from) {
      throw new Error(
        'twilioSmsAdapter: one of TWILIO_MESSAGING_SERVICE_SID or TWILIO_FROM_NUMBER must be set',
      );
    }
    const client = getClient();
    try {
      const createOpts: Parameters<TwilioMessageCreate>[0] = {
        to: args.destination,
        body: args.body,
      };
      if (messagingServiceSid) {
        createOpts.messagingServiceSid = messagingServiceSid;
      } else if (from) {
        createOpts.from = from;
      }
      const msg = await client.messages.create(createOpts);
      return {
        provider: 'twilio',
        provider_message_id: msg.sid,
        delivered_status: 'sent',
      };
    } catch (err) {
      const e = err as { code?: string | number; status?: number; message?: string };
      throw new Error(
        `twilioSmsAdapter ${e.code ?? e.status ?? 'TwilioError'}: ${e.message ?? String(err)}`,
      );
    }
  },
};

/**
 * Registers the real Twilio SMS adapter at boot. Only registers when
 * the required Twilio creds are present so we don't shadow the synthetic
 * stub used in dev/test with an adapter that's guaranteed to throw.
 */
export function registerTwilioSmsAdapter(): boolean {
  if (!process.env.TWILIO_ACCOUNT_SID || !process.env.TWILIO_AUTH_TOKEN) return false;
  if (!process.env.TWILIO_MESSAGING_SERVICE_SID && !process.env.TWILIO_FROM_NUMBER) return false;
  registerAdapter(twilioSmsAdapter);
  return true;
}
