'use client';

import { TalkToAgent } from '@projexlight/voice-widget';
import { startTestSessionAction } from './actions';

/** The embedded TalkToAgent widget, wired to the server action that starts the session. */
export function TalkPanel({ agentId, agentName }: { agentId: string; agentName: string }) {
  return <TalkToAgent key={agentId} title={agentName} startSession={() => startTestSessionAction(agentId)} />;
}
