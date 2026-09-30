/**
 * The widget's state machine, kept pure (no DOM, no LiveKit) so every transition is
 * decidable without a browser.
 *
 *   idle ──start──▶ requesting_mic ──granted──▶ connecting ──connected──▶ connected
 *                        │                          │                      │  ▲ mute/unmute
 *                        ├─denied──▶ mic_denied     ├─failed──▶ error      │
 *                        └─absent──▶ no_microphone  │                      ├─agent_joined (agent_present)
 *                                                   │                      └─hang_up / disconnected ──▶ ended
 *   mic_denied | no_microphone | error | ended ──start──▶ requesting_mic   (retry)
 *
 * The agent is a separate participant in the room; `agent_present` only turns true when it
 * joins, so a room with no agent reads "waiting for the agent" rather than a silent call.
 */

export type WidgetStatus =
  | 'idle'
  | 'requesting_mic'
  | 'mic_denied'
  | 'no_microphone'
  | 'connecting'
  | 'connected'
  | 'ended'
  | 'error';

export interface WidgetState {
  status: WidgetStatus;
  muted: boolean;
  agent_present: boolean;
  /** Human-readable explanation for mic_denied / no_microphone / error / ended. */
  message: string | null;
  /** The test-session call id, once a session was started. */
  call_id: string | null;
}

export type WidgetEvent =
  | { type: 'start' }
  | { type: 'mic_granted' }
  | { type: 'mic_denied' }
  | { type: 'mic_absent' }
  | { type: 'session_started'; call_id: string }
  | { type: 'connected' }
  | { type: 'failed'; message: string }
  | { type: 'agent_joined' }
  | { type: 'agent_left' }
  | { type: 'toggle_mute' }
  | { type: 'hang_up' }
  | { type: 'disconnected'; message?: string };

export const initialWidgetState: WidgetState = {
  status: 'idle', muted: false, agent_present: false, message: null, call_id: null,
};

const RETRYABLE: WidgetStatus[] = ['idle', 'mic_denied', 'no_microphone', 'error', 'ended'];

export function widgetReducer(state: WidgetState, event: WidgetEvent): WidgetState {
  switch (event.type) {
    case 'start':
      return RETRYABLE.includes(state.status) ? { ...initialWidgetState, status: 'requesting_mic' } : state;
    case 'mic_granted':
      return state.status === 'requesting_mic' ? { ...state, status: 'connecting' } : state;
    case 'mic_denied':
      return state.status === 'requesting_mic'
        ? { ...state, status: 'mic_denied', message: 'Microphone access was blocked. Allow the microphone for this site in your browser, then try again.' }
        : state;
    case 'mic_absent':
      return state.status === 'requesting_mic'
        ? { ...state, status: 'no_microphone', message: 'No microphone was found. Connect one and try again.' }
        : state;
    case 'session_started':
      return state.status === 'connecting' ? { ...state, call_id: event.call_id } : state;
    case 'connected':
      return state.status === 'connecting' ? { ...state, status: 'connected', message: null } : state;
    case 'failed':
      return state.status === 'connecting' || state.status === 'connected'
        ? { ...state, status: 'error', agent_present: false, message: event.message }
        : state;
    case 'agent_joined':
      return state.status === 'connected' ? { ...state, agent_present: true } : state;
    case 'agent_left':
      return state.status === 'connected' ? { ...state, agent_present: false } : state;
    case 'toggle_mute':
      return state.status === 'connected' ? { ...state, muted: !state.muted } : state;
    case 'hang_up':
      return state.status === 'connecting' || state.status === 'connected'
        ? { ...state, status: 'ended', agent_present: false, muted: false, message: 'Call ended.' }
        : state;
    case 'disconnected':
      return state.status === 'connected' || state.status === 'connecting'
        ? { ...state, status: 'ended', agent_present: false, muted: false, message: event.message ?? 'The session ended.' }
        : state;
    default:
      return state;
  }
}

/** Short label for the current state — what the widget shows next to its buttons. */
export function statusLabel(s: WidgetState): string {
  switch (s.status) {
    case 'idle': return 'Ready';
    case 'requesting_mic': return 'Waiting for microphone permission…';
    case 'mic_denied': return 'Microphone blocked';
    case 'no_microphone': return 'No microphone';
    case 'connecting': return 'Connecting…';
    case 'connected': return s.agent_present ? (s.muted ? 'Connected — muted' : 'Connected') : 'Connected — waiting for the agent…';
    case 'ended': return 'Call ended';
    case 'error': return 'Connection failed';
  }
}

/** Maps a getUserMedia rejection to the event it means. */
export function micErrorEvent(err: unknown): WidgetEvent {
  const name = (err as { name?: string } | null)?.name ?? '';
  if (name === 'NotFoundError' || name === 'DevicesNotFoundError' || name === 'OverconstrainedError') return { type: 'mic_absent' };
  // NotAllowedError / PermissionDeniedError / SecurityError (insecure origin) all mean "not permitted".
  return { type: 'mic_denied' };
}
