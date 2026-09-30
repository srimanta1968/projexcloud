import { useCallback, useEffect, useReducer, useRef } from 'react';
import { Room, RoomEvent, Track, type RemoteTrack } from 'livekit-client';
import { initialWidgetState, micErrorEvent, widgetReducer, type WidgetState } from './state';

/** What the host app's backend returns when it starts a test session (POST /api/voice-agent/test-sessions). */
export interface TalkSession {
  call_id: string;
  livekit_url: string;
  /** LiveKit room token for this browser participant. */
  token: string;
}

/**
 * Starts a session. Runs on the host app's side (a server action or its own API route), so
 * the tenant credential never reaches the browser — only the room URL and room token do.
 */
export type StartSession = () => Promise<TalkSession>;

export interface TalkToAgentControls {
  state: WidgetState;
  start: () => Promise<void>;
  toggleMute: () => Promise<void>;
  hangUp: () => Promise<void>;
}

type MediaDevicesLike = { getUserMedia(c: { audio: boolean }): Promise<{ getTracks(): { stop(): void }[] }> };

/**
 * Headless TalkToAgent: microphone permission first (so a refusal is reported as such, not
 * as a connection failure), then the session, then the LiveKit room with the mic published
 * and the agent's audio played through a detached <audio> element.
 */
export function useTalkToAgent(startSession: StartSession): TalkToAgentControls {
  const [state, dispatch] = useReducer(widgetReducer, initialWidgetState);
  const roomRef = useRef<Room | null>(null);
  const audioRef = useRef<HTMLMediaElement[]>([]);
  const mutedRef = useRef(false);

  const cleanup = useCallback(() => {
    for (const el of audioRef.current) el.remove();
    audioRef.current = [];
    const room = roomRef.current;
    roomRef.current = null;
    if (room) {
      room.removeAllListeners();
      void room.disconnect();
    }
  }, []);

  useEffect(() => cleanup, [cleanup]);

  const start = useCallback(async () => {
    cleanup();
    mutedRef.current = false;
    dispatch({ type: 'start' });
    const media = (typeof navigator !== 'undefined' ? navigator.mediaDevices : undefined) as MediaDevicesLike | undefined;
    if (!media?.getUserMedia) {
      dispatch({ type: 'mic_absent' });
      return;
    }
    try {
      const probe = await media.getUserMedia({ audio: true });
      probe.getTracks().forEach((t) => t.stop()); // LiveKit opens its own track
    } catch (err) {
      dispatch(micErrorEvent(err));
      return;
    }
    dispatch({ type: 'mic_granted' });

    let session: TalkSession;
    try {
      session = await startSession();
      dispatch({ type: 'session_started', call_id: session.call_id });
    } catch (err) {
      dispatch({ type: 'failed', message: `Could not start a session: ${(err as Error).message}` });
      return;
    }

    const room = new Room({ adaptiveStream: true, dynacast: true });
    roomRef.current = room;
    const onAgentChange = () => dispatch({ type: room.remoteParticipants.size > 0 ? 'agent_joined' : 'agent_left' });
    room
      .on(RoomEvent.ParticipantConnected, onAgentChange)
      .on(RoomEvent.ParticipantDisconnected, onAgentChange)
      .on(RoomEvent.TrackSubscribed, (track: RemoteTrack) => {
        if (track.kind !== Track.Kind.Audio) return;
        const el = track.attach();
        el.style.display = 'none';
        document.body.appendChild(el);
        audioRef.current.push(el);
      })
      .on(RoomEvent.TrackUnsubscribed, (track: RemoteTrack) => {
        for (const el of track.detach()) el.remove();
      })
      .on(RoomEvent.Disconnected, () => {
        if (roomRef.current === room) {
          dispatch({ type: 'disconnected' });
          cleanup();
        }
      });
    try {
      await room.connect(session.livekit_url, session.token);
      await room.localParticipant.setMicrophoneEnabled(true);
      dispatch({ type: 'connected' });
      if (room.remoteParticipants.size > 0) dispatch({ type: 'agent_joined' });
    } catch (err) {
      dispatch({ type: 'failed', message: `Could not connect: ${(err as Error).message}` });
      cleanup();
    }
  }, [startSession, cleanup]);

  const toggleMute = useCallback(async () => {
    const room = roomRef.current;
    if (!room) return;
    mutedRef.current = !mutedRef.current;
    await room.localParticipant.setMicrophoneEnabled(!mutedRef.current);
    dispatch({ type: 'toggle_mute' });
  }, []);

  const hangUp = useCallback(async () => {
    dispatch({ type: 'hang_up' });
    cleanup();
  }, [cleanup]);

  return { state, start, toggleMute, hangUp };
}
