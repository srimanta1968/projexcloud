import type { AudioFrame } from '@livekit/rtc-node';
import type { AudioSink, CallMedia } from '../pipeline/media';
import type { SttProvider, SttStream, Transcript, TtsOptions, TtsProvider } from '../providers/types';

/**
 * Loopback telephony for simulated calls (VA·E10 · TK-4517): no phone line, no LiveKit room.
 *
 *   caller -> agent   say(text) plays a burst of speech-like audio (so the agent's VAD, turn
 *                     detection and barge-in run exactly as on a call), then the scripted STT
 *                     delivers `text` as the final transcript — the words are known, so there
 *                     is nothing to recognise.
 *   agent -> caller   the silent TTS turns each clause into silence of a speech-like length;
 *                     the sink "plays" it in real time, so interruptions land mid-sentence.
 *
 * These providers exist only here. They are not in the STT/TTS registries a real call uses, so
 * no call reaching the runtime from a phone or a browser can ever run on them.
 */

const FRAME_MS = 20;
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, Math.max(0, ms)));

export interface LoopbackOptions {
  /** Caller speech duration per word (default 220 ms). */
  callerMsPerWord?: number;
  /** Agent (silent TTS) speech duration per word (default 120 ms: fast-forwarded). */
  agentMsPerWord?: number;
  /** Delay between the caller's last word and the final transcript (default 350 ms). */
  endpointMs?: number;
}

/** Plays the agent's frames in real time without a speaker at the other end. */
class LoopbackSink implements AudioSink {
  private playEnd = 0;
  constructor(private readonly queueMs: number) {}

  get queuedDuration(): number {
    return Math.max(0, this.playEnd - Date.now());
  }

  get playing(): boolean {
    return this.queuedDuration > 0;
  }

  captureFrame(frame: AudioFrame): Promise<void> {
    const now = Date.now();
    this.playEnd = Math.max(now, this.playEnd) + (frame.samplesPerChannel / frame.sampleRate) * 1000;
    return sleep(this.playEnd - now - this.queueMs);
  }

  clearQueue(): void {
    this.playEnd = Date.now();
  }

  waitForPlayout(): Promise<void> {
    return sleep(this.queuedDuration);
  }

  async close(): Promise<void> {
    this.playEnd = Date.now();
  }
}

class ScriptedSttStream implements SttStream {
  private transcriptCb: ((t: Transcript) => void) | null = null;
  closed = false;
  write(): void { /* the words arrive as text; the audio only drives the VAD */ }
  close(): void { this.closed = true; }
  onTranscript(cb: (t: Transcript) => void): void { this.transcriptCb = cb; }
  onSpeechStart(): void { /* the VAD reports speech from the audio */ }
  onError(): void { /* a script cannot fail */ }
  deliver(text: string): void {
    if (!this.closed) this.transcriptCb?.({ text, final: true, endOfTurn: true });
  }
}

export class LoopbackMedia implements CallMedia {
  readonly roomName: string;
  private sink: LoopbackSink | null = null;
  private stt: ScriptedSttStream | null = null;
  private pending: Int16Array[] = [];
  private ended = false;
  private endResolve!: () => void;
  private readonly endPromise = new Promise<void>((r) => { this.endResolve = r; });
  private readyResolve!: () => void;
  /** Resolves once the session is listening (reading caller audio). */
  readonly ready = new Promise<void>((r) => { this.readyResolve = r; });
  private readonly callerMsPerWord: number;
  private readonly agentMsPerWord: number;
  private readonly endpointMs: number;

  constructor(callId: string, opts: LoopbackOptions = {}) {
    this.roomName = `sim-${callId}`;
    this.callerMsPerWord = opts.callerMsPerWord ?? 220;
    this.agentMsPerWord = opts.agentMsPerWord ?? 120;
    this.endpointMs = opts.endpointMs ?? 350;
  }

  /** The agent is audibly talking right now. */
  get agentSpeaking(): boolean {
    return this.sink?.playing ?? false;
  }

  async openAgentAudio(_rate: number, queueMs: number): Promise<AudioSink> {
    this.sink = new LoopbackSink(queueMs);
    return this.sink;
  }

  async callerAudio(rate: number): Promise<AsyncIterable<Int16Array> | null> {
    const self = this;
    const frameSamples = Math.round((rate * FRAME_MS) / 1000);
    this.readyResolve();
    return (async function* () {
      let next = Date.now();
      while (!self.ended) {
        yield self.pending.shift() ?? new Int16Array(frameSamples);
        next += FRAME_MS;
        await sleep(next - Date.now());
      }
    })();
  }

  /**
   * The simulated caller says `text`: speech-like audio for its duration, then the final
   * transcript. Resolves once the transcript is delivered.
   */
  async say(text: string, rate = 16000): Promise<void> {
    const words = Math.max(1, text.trim().split(/\s+/).length);
    const frames = Math.max(10, Math.round((words * this.callerMsPerWord) / FRAME_MS));
    const frameSamples = Math.round((rate * FRAME_MS) / 1000);
    for (let i = 0; i < frames; i++) {
      const f = new Int16Array(frameSamples);
      for (let j = 0; j < frameSamples; j++) f[j] = Math.round((Math.random() * 2 - 1) * 6000);
      this.pending.push(f);
    }
    await sleep(frames * FRAME_MS + this.endpointMs);
    this.stt?.deliver(text);
  }

  caller(): { identity: string | null; isSip: boolean } {
    return { identity: 'simulated-caller', isSip: false };
  }

  async waitForParticipant(): Promise<boolean> {
    return false; // nobody joins a simulated call; a bridge transfer falls back to a callback
  }

  untilEnds(): Promise<void> {
    return this.endPromise;
  }

  /** The simulated caller hangs up. */
  hangUp(): void {
    this.ended = true;
    this.endResolve();
  }

  end(): void {
    this.hangUp();
  }

  async close(): Promise<void> {
    this.ended = true;
  }

  /** Speech-to-text for this call: the script's words, delivered by say(). */
  readonly sttProvider: SttProvider = {
    id: 'loopback',
    connect: async () => {
      this.stt = new ScriptedSttStream();
      return this.stt;
    },
  };

  /** Text-to-speech for this call: silence as long as the words would take to say. */
  readonly ttsProvider: TtsProvider = {
    id: 'silent',
    sampleRate: () => 24000,
    synthesize: (text: string, _opts: TtsOptions, signal: AbortSignal) => {
      const msPerWord = this.agentMsPerWord;
      return (async function* () {
        const words = Math.max(1, text.trim().split(/\s+/).length);
        let remaining = Math.round((words * msPerWord * 24000) / 1000);
        while (remaining > 0 && !signal.aborted) {
          const n = Math.min(remaining, 2400);
          remaining -= n;
          yield new Int16Array(n);
          await sleep(0);
        }
      })();
    },
  };
}
