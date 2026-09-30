'use server';

import { gateway } from '../../../lib/gateway';

export interface WidgetSession {
  call_id: string;
  livekit_url: string;
  token: string;
}

/**
 * Starts a test session for an agent (its latest version — a draft is fine) on the server,
 * with the admin's session cookie. Only the LiveKit room URL and room token go back to the
 * browser; the tenant credential never does.
 */
export async function startTestSessionAction(agentId: string): Promise<WidgetSession> {
  const { session } = await gateway.post<{ session: WidgetSession & Record<string, unknown> }>(
    '/api/voice-agent/test-sessions',
    { agent_id: agentId },
  );
  return { call_id: session.call_id, livekit_url: session.livekit_url, token: session.token };
}
