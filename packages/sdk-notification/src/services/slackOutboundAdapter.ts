// Real Slack outbound notification adapter implementing the ProviderAdapter
// contract from providerAdapters.ts. Replaces the synthetic 'slack-outbound'
// stub for the 'slack' channel.
//
// Env var (must be present for register*Adapter() to wire this in):
//   SLACK_NOTIFICATION_BOT_TOKEN — xoxb-… token for the notification bot.
//
// IMPORTANT: this is intentionally distinct from SLACK_BOT_TOKEN used by
// connector-slack. Tenant-installed Slack apps (used for conversational
// connectors) must not also be the outbound notifier — splitting tokens
// keeps notification routing from being throttled or revoked when a tenant
// uninstalls the conversational bot.
//
// Throws on non-2xx HTTP or response.ok !== true so the failover chain in
// sendWithFailover() advances to the next registered provider.

import {
  registerAdapter,
  type ProviderAdapter,
  type SendArgs,
  type SendResult,
} from './providerAdapters';

interface SlackPostMessageResponse {
  ok: boolean;
  ts?: string;
  channel?: string;
  error?: string;
  warning?: string;
}

export const slackOutboundAdapter: ProviderAdapter = {
  provider: 'slack-outbound',
  channel: 'slack',
  async send(args: SendArgs): Promise<SendResult> {
    const token = process.env.SLACK_NOTIFICATION_BOT_TOKEN;
    if (!token) {
      throw new Error('slackOutboundAdapter: SLACK_NOTIFICATION_BOT_TOKEN must be set');
    }

    const blocks = (args.metadata?.blocks as unknown) as unknown[] | undefined;

    const body: Record<string, unknown> = {
      channel: args.destination,
      text: args.body,
    };
    if (Array.isArray(blocks) && blocks.length > 0) {
      body.blocks = blocks;
    }

    const res = await fetch('https://slack.com/api/chat.postMessage', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json; charset=utf-8',
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`slackOutboundAdapter HTTP ${res.status}: ${text || res.statusText}`);
    }

    const json = (await res.json()) as SlackPostMessageResponse;
    if (!json.ok) {
      // Slack returns 200 OK with { ok: false, error: 'channel_not_found' | … }
      throw new Error(`slackOutboundAdapter SlackError: ${json.error ?? 'unknown_error'}`);
    }

    return {
      provider: 'slack-outbound',
      provider_message_id: json.ts ?? `slack_${Date.now().toString(36)}`,
      delivered_status: 'sent',
    };
  },
};

/**
 * Registers the real Slack outbound adapter at boot. Only registers when
 * SLACK_NOTIFICATION_BOT_TOKEN is set so we don't shadow the synthetic
 * stub used in dev/test with an adapter guaranteed to throw.
 */
export function registerSlackOutboundAdapter(): boolean {
  if (!process.env.SLACK_NOTIFICATION_BOT_TOKEN) return false;
  registerAdapter(slackOutboundAdapter);
  return true;
}
