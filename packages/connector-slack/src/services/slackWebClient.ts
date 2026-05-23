/**
 * Minimal Slack Web API client. Replaces the stub in src/index.ts callTool
 * when SLACK_BOT_TOKEN is set. Real production swaps the token resolver for
 * sdk-secrets / sdk-vault — never embeds raw tokens in env in prod.
 *
 * Methods: chat.postMessage, conversations.list, users.lookupByEmail. Each
 * returns Slack's raw response so callers can branch on `ok: false` +
 * `error` per https://api.slack.com/web.
 */

const SLACK_BASE = 'https://slack.com/api';

export type TokenResolver = () => Promise<string | null>;

let activeResolver: TokenResolver = async () => process.env.SLACK_BOT_TOKEN ?? null;

export function registerSlackTokenResolver(resolver: TokenResolver): void {
  activeResolver = resolver;
}

async function callApi(method: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
  const token = await activeResolver();
  if (!token) {
    return { ok: false, error: 'NotConfigured', detail: 'no Slack bot token available' };
  }
  const res = await fetch(`${SLACK_BASE}/${method}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    return { ok: false, error: 'SlackHttpError', http_status: res.status };
  }
  return res.json() as Promise<Record<string, unknown>>;
}

export async function chatPostMessage(args: {
  channel: string;
  text: string;
  blocks?: unknown[];
  thread_ts?: string;
}): Promise<Record<string, unknown>> {
  return callApi('chat.postMessage', args);
}

export async function conversationsList(args: {
  cursor?: string;
  limit?: number;
  exclude_archived?: boolean;
}): Promise<Record<string, unknown>> {
  return callApi('conversations.list', args);
}

export async function usersLookupByEmail(args: { email: string }): Promise<Record<string, unknown>> {
  return callApi('users.lookupByEmail', args);
}

/**
 * OAuth v2 install: exchange the temporary code Slack returns to the
 * redirect_uri for a workspace bot token. Production stores the result via
 * sdk-vault + sdk-connectors.installConnector; here we return the raw
 * response for the caller to persist.
 */
export async function oauthExchange(args: {
  client_id: string;
  client_secret: string;
  code: string;
  redirect_uri?: string;
}): Promise<Record<string, unknown>> {
  // OAuth v2 uses application/x-www-form-urlencoded, not JSON.
  const params = new URLSearchParams({
    client_id: args.client_id,
    client_secret: args.client_secret,
    code: args.code,
  });
  if (args.redirect_uri) params.append('redirect_uri', args.redirect_uri);
  const res = await fetch(`${SLACK_BASE}/oauth.v2.access`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString(),
  });
  if (!res.ok) {
    return { ok: false, error: 'SlackHttpError', http_status: res.status };
  }
  return res.json() as Promise<Record<string, unknown>>;
}
