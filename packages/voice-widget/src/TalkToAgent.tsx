import type { CSSProperties } from 'react';
import { statusLabel } from './state';
import { useTalkToAgent, type StartSession } from './useTalkToAgent';

export interface TalkToAgentProps {
  /** Starts a test session on the host's backend and returns { call_id, livekit_url, token }. */
  startSession: StartSession;
  /** Heading shown in the widget, e.g. the agent's name. */
  title?: string;
  className?: string;
  style?: CSSProperties;
}

const box: CSSProperties = {
  border: '1px solid #d4d4d8', borderRadius: 12, padding: 16, maxWidth: 360,
  fontFamily: 'system-ui, sans-serif', display: 'grid', gap: 12,
};
const btn: CSSProperties = { padding: '8px 14px', borderRadius: 8, border: '1px solid #a1a1aa', background: '#fff', cursor: 'pointer' };
const primary: CSSProperties = { ...btn, background: '#18181b', color: '#fff', borderColor: '#18181b' };
const danger: CSSProperties = { ...btn, background: '#b91c1c', color: '#fff', borderColor: '#b91c1c' };

/**
 * Embeddable "talk to the agent" widget (VA·E9 · TK-4511). Unstyled beyond a minimal frame
 * so any host can theme it; every element carries a data-testid and the root a data-state
 * for tests and CSS.
 *
 *   <TalkToAgent title="Scheduling assistant" startSession={() => startTestSessionAction(agentId)} />
 */
export function TalkToAgent({ startSession, title, className, style }: TalkToAgentProps) {
  const { state, start, toggleMute, hangUp } = useTalkToAgent(startSession);
  const live = state.status === 'connecting' || state.status === 'connected';
  const canStart = !live && state.status !== 'requesting_mic';

  return (
    <div className={className} style={{ ...box, ...style }} data-testid="talk-to-agent" data-state={state.status}>
      {title ? <strong data-testid="talk-to-agent-title">{title}</strong> : null}
      <div role="status" aria-live="polite" data-testid="talk-to-agent-status">
        {statusLabel(state)}
      </div>
      {state.message ? (
        <div role={state.status === 'mic_denied' || state.status === 'error' ? 'alert' : undefined} data-testid="talk-to-agent-message" style={{ color: state.status === 'ended' ? '#52525b' : '#b91c1c' }}>
          {state.message}
        </div>
      ) : null}
      <div style={{ display: 'flex', gap: 8 }}>
        {canStart ? (
          <button type="button" style={primary} onClick={() => void start()} data-testid="talk-to-agent-start">
            {state.status === 'idle' ? 'Talk to agent' : 'Try again'}
          </button>
        ) : null}
        {state.status === 'connected' ? (
          <button type="button" style={btn} onClick={() => void toggleMute()} aria-pressed={state.muted} data-testid="talk-to-agent-mute">
            {state.muted ? 'Unmute' : 'Mute'}
          </button>
        ) : null}
        {live ? (
          <button type="button" style={danger} onClick={() => void hangUp()} data-testid="talk-to-agent-hangup">
            Hang up
          </button>
        ) : null}
      </div>
    </div>
  );
}
