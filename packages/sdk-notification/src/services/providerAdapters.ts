import type { NotificationChannel, NotificationProvider } from '../models/notification.model';

/**
 * Provider adapter contract per FR-NTF-2.
 *
 * Each provider implements `send()` returning a normalized result. The
 * channel router (channelRouter.ts) picks the provider by channel +
 * tenant/per-app preference, then calls send(). The actual SDK call is
 * deferred — adapters here are NO-OP stubs that succeed with a synthetic
 * provider_message_id. Production deploys swap in real vendor SDKs by
 * setting NOTIFICATION_PROVIDER_DRIVERS=real and pulling in @twilio/sdk,
 * @aws-sdk/client-sesv2, etc., gated by the same interface.
 *
 * Failover: when the primary provider throws, the router calls the next
 * registered provider for the same channel (per PRD NFR <=5s failover).
 */

export interface SendArgs {
  channel: NotificationChannel;
  destination: string;
  subject?: string;
  body: string;
  metadata?: Record<string, unknown>;
}

export interface SendResult {
  provider: NotificationProvider;
  provider_message_id: string;
  delivered_status: 'sent' | 'delivered' | 'failed' | 'bounced';
}

export interface ProviderAdapter {
  readonly provider: NotificationProvider;
  readonly channel: NotificationChannel;
  send(args: SendArgs): Promise<SendResult>;
}

/**
 * Synthetic adapters keep tests deterministic. In production, a synthetic
 * "send" silently looks successful but nothing reaches the recipient — the
 * worst failure mode (alerts swallowed, audit clean). Refuse to run synthetic
 * in prod unless ALLOW_SYNTHETIC_NOTIFICATION_PROVIDERS=true is explicitly set.
 */
const SYNTHETIC_ALLOWED = (): boolean => {
  if (process.env.NODE_ENV !== 'production') return true;
  return process.env.ALLOW_SYNTHETIC_NOTIFICATION_PROVIDERS === 'true';
};

function makeSyntheticAdapter(
  provider: NotificationProvider,
  channel: NotificationChannel,
): ProviderAdapter {
  return {
    provider,
    channel,
    async send(args: SendArgs): Promise<SendResult> {
      if (!SYNTHETIC_ALLOWED()) {
        throw new Error(`sdk-notification: provider '${provider}' (${channel}) is the synthetic stub in production — register a real adapter via registerAdapter() before boot, or set ALLOW_SYNTHETIC_NOTIFICATION_PROVIDERS=true for sandbox tenants`);
      }
      if (args.destination.startsWith('fail:')) {
        throw new Error(`Synthetic provider ${provider} forced failure on ${args.destination}`);
      }
      const stamp = Date.now().toString(36);
      return {
        provider,
        provider_message_id: `${provider}_${stamp}_${Math.random().toString(36).slice(2, 8)}`,
        delivered_status: 'sent',
      };
    },
  };
}

const REGISTRY: Record<NotificationChannel, ProviderAdapter[]> = {
  email: [makeSyntheticAdapter('ses', 'email')],
  sms: [makeSyntheticAdapter('twilio', 'sms')],
  whatsapp: [makeSyntheticAdapter('whatsapp-bsp', 'whatsapp')],
  push: [makeSyntheticAdapter('apns', 'push'), makeSyntheticAdapter('fcm', 'push')],
  slack: [makeSyntheticAdapter('slack-outbound', 'slack')],
};

export function getProvidersForChannel(channel: NotificationChannel): ProviderAdapter[] {
  return REGISTRY[channel] ?? [];
}

/**
 * Sends with failover: tries providers in registered order, returns the
 * first success. Throws AggregateError if every provider fails.
 */
export async function sendWithFailover(
  channel: NotificationChannel,
  args: SendArgs,
): Promise<SendResult> {
  const providers = getProvidersForChannel(channel);
  if (providers.length === 0) {
    throw new Error(`No provider registered for channel ${channel}`);
  }
  const errors: Error[] = [];
  for (const adapter of providers) {
    try {
      return await adapter.send(args);
    } catch (err) {
      errors.push(err as Error);
    }
  }
  throw new AggregateError(errors, `All providers failed for channel ${channel}`);
}

/**
 * For tests + dev: allow runtime registration of additional adapters
 * (e.g. real Twilio adapter loaded conditionally based on env).
 */
export function registerAdapter(adapter: ProviderAdapter): void {
  if (!REGISTRY[adapter.channel]) REGISTRY[adapter.channel] = [];
  REGISTRY[adapter.channel].unshift(adapter); // most-recently-registered wins
}
