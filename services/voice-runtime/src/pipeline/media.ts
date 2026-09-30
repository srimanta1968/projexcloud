import {
  AudioSource,
  AudioStream,
  LocalAudioTrack,
  ParticipantKind,
  RoomEvent,
  TrackKind,
  TrackPublishOptions,
  TrackSource,
  type RemoteParticipant,
  type RemoteTrack,
  type Room,
} from '@livekit/rtc-node';

/**
 * The media a voice session runs over (VA·E10 · TK-4517). A real call runs over a LiveKit room
 * (LiveKitMedia); a simulated call — sandbox or evaluation run — runs over in-process loopback
 * media (sim/loopback.ts), with no room and no phone line. VoiceSession sees only this seam.
 */

/** Where the agent's voice goes: the subset of LiveKit's AudioSource the Speaker uses. */
export type AudioSink = Pick<AudioSource, 'captureFrame' | 'clearQueue' | 'waitForPlayout' | 'queuedDuration'> & {
  close(): Promise<void>;
};

export interface CallMedia {
  readonly roomName: string;
  /** Publishes the agent's voice: mono frames at `rate`, queued up to `queueMs`. */
  openAgentAudio(rate: number, queueMs: number): Promise<AudioSink>;
  /** The caller's audio as mono PCM16 at `rate`, until the call ends; null if it never arrives. */
  callerAudio(rate: number): Promise<AsyncIterable<Int16Array> | null>;
  /** Who the caller is, for a transfer. */
  caller(): { identity: string | null; isSip: boolean };
  /** True once a participant with this identity joins (bridge transfer), false on timeout/abort. */
  waitForParticipant(identity: string, timeoutMs: number, signal: AbortSignal): Promise<boolean>;
  /** Resolves when the caller has left, or end() was called. */
  untilEnds(): Promise<void>;
  /** Ends the session while others may stay (after a bridge transfer). */
  end(): void;
  /** Stops reading caller audio. */
  close(): Promise<void>;
}

/** A real call: the LiveKit room this worker's agent participant joined. */
export class LiveKitMedia implements CallMedia {
  private callerStream: AudioStream | null = null;
  private endNow: (() => void) | null = null;

  constructor(private readonly room: Room, private readonly signal: AbortSignal, private readonly fallbackRoom = '') {}

  get roomName(): string {
    return this.room.name ?? this.fallbackRoom;
  }

  async openAgentAudio(rate: number, queueMs: number): Promise<AudioSink> {
    const source = new AudioSource(rate, 1, queueMs);
    const track = LocalAudioTrack.createAudioTrack('agent-voice', source);
    const opts = new TrackPublishOptions();
    opts.source = TrackSource.SOURCE_MICROPHONE;
    await this.room.localParticipant!.publishTrack(track, opts);
    return source;
  }

  private findCallerTrack(): RemoteTrack | null {
    for (const p of this.room.remoteParticipants.values()) {
      if (p.kind === ParticipantKind.AGENT) continue;
      for (const pub of p.trackPublications.values()) {
        if (pub.kind === TrackKind.KIND_AUDIO && pub.track) return pub.track as RemoteTrack;
      }
    }
    return null;
  }

  private waitForCallerTrack(): Promise<RemoteTrack | null> {
    const now = this.findCallerTrack();
    if (now) return Promise.resolve(now);
    return new Promise((resolve) => {
      const on = (track: RemoteTrack, _pub: unknown, p: RemoteParticipant): void => {
        if (track.kind !== TrackKind.KIND_AUDIO || p.kind === ParticipantKind.AGENT) return;
        this.room.off(RoomEvent.TrackSubscribed, on);
        resolve(track);
      };
      this.room.on(RoomEvent.TrackSubscribed, on);
      this.signal.addEventListener('abort', () => { this.room.off(RoomEvent.TrackSubscribed, on); resolve(null); }, { once: true });
    });
  }

  async callerAudio(rate: number): Promise<AsyncIterable<Int16Array> | null> {
    const track = await this.waitForCallerTrack();
    if (!track) return null;
    const stream = new AudioStream(track, rate, 1);
    this.callerStream = stream;
    return (async function* () {
      const reader = stream.getReader();
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) return;
          yield value.data;
        }
      } finally {
        reader.releaseLock();
      }
    })();
  }

  caller(): { identity: string | null; isSip: boolean } {
    const others = [...this.room.remoteParticipants.values()].filter((p) => p.kind !== ParticipantKind.AGENT);
    const sip = others.find((p) => p.kind === ParticipantKind.SIP);
    return { identity: (sip ?? others[0])?.identity ?? null, isSip: !!sip };
  }

  waitForParticipant(identity: string, timeoutMs: number, signal: AbortSignal): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      if (this.room.remoteParticipants.has(identity)) return resolve(true);
      const t = setTimeout(() => { this.room.off(RoomEvent.ParticipantConnected, on); resolve(false); }, timeoutMs);
      const on = (p: RemoteParticipant): void => {
        if (p.identity !== identity) return;
        clearTimeout(t);
        this.room.off(RoomEvent.ParticipantConnected, on);
        resolve(true);
      };
      this.room.on(RoomEvent.ParticipantConnected, on);
      signal.addEventListener('abort', () => { clearTimeout(t); resolve(false); }, { once: true });
    });
  }

  untilEnds(): Promise<void> {
    return new Promise((resolve) => {
      const done = (): void => {
        this.room.off(RoomEvent.ParticipantDisconnected, onLeft);
        this.room.off(RoomEvent.Disconnected, done);
        resolve();
      };
      const onLeft = (p: RemoteParticipant): void => {
        if (p.kind === ParticipantKind.AGENT) return;
        const callers = [...this.room.remoteParticipants.values()].filter((x) => x.kind !== ParticipantKind.AGENT);
        if (callers.length === 0) done();
      };
      this.room.on(RoomEvent.ParticipantDisconnected, onLeft);
      this.room.on(RoomEvent.Disconnected, done);
      this.signal.addEventListener('abort', done, { once: true });
      this.endNow = done;
      if ([...this.room.remoteParticipants.values()].every((x) => x.kind === ParticipantKind.AGENT)) done();
    });
  }

  end(): void {
    this.endNow?.();
  }

  async close(): Promise<void> {
    await this.callerStream?.cancel().catch(() => undefined);
  }
}
