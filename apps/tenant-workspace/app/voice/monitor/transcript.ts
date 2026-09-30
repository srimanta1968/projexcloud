/**
 * Pure transcript reducer for the live monitor (VA·E9 · TK-4515): merges the WebSocket's
 * snapshot, turn, status and ended events into one ordered transcript. Turns are keyed by
 * turn_index, so a turn delivered by both the snapshot and the live stream (the gateway
 * subscribes before it snapshots, precisely so none falls in the gap) appears once.
 */

export interface Turn {
  turn_index: number;
  speaker: 'caller' | 'agent' | 'system';
  text: string;
  interrupted?: boolean;
}

export interface LiveState {
  status: string | null;
  disposition: string | null;
  ended: boolean;
  turns: Turn[];
}

export type LiveMessage =
  | { kind: 'snapshot'; status: string | null; transcript: Turn[] }
  | { kind: 'turn'; turn: Turn }
  | { kind: 'status'; status: string }
  | { kind: 'ended'; status?: string; disposition?: string | null };

export const emptyLive: LiveState = { status: null, disposition: null, ended: false, turns: [] };

function mergeTurns(existing: Turn[], incoming: Turn[]): Turn[] {
  const byIndex = new Map(existing.map((t) => [t.turn_index, t]));
  for (const t of incoming) byIndex.set(t.turn_index, t);
  return Array.from(byIndex.values()).sort((a, b) => a.turn_index - b.turn_index);
}

export function liveReducer(state: LiveState, msg: LiveMessage): LiveState {
  switch (msg.kind) {
    case 'snapshot':
      return { ...state, status: msg.status ?? state.status, turns: mergeTurns(state.turns, msg.transcript ?? []) };
    case 'turn':
      return msg.turn ? { ...state, turns: mergeTurns(state.turns, [msg.turn]) } : state;
    case 'status':
      return { ...state, status: msg.status };
    case 'ended':
      return { ...state, ended: true, status: msg.status ?? state.status, disposition: msg.disposition ?? state.disposition };
    default:
      return state;
  }
}
