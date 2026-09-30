import { AudioFrame, type AudioSource } from '@livekit/rtc-node';
import { log } from '../log';
import type { TtsOptions, TtsProvider } from '../providers/types';

/**
 * The agent's voice (VA·E1 · TK-4458): plays queued text clauses through TTS into the
 * call's LiveKit audio source, in order.
 *
 *   - Synthesis is pipelined: while clause N plays, clause N+1 is already being synthesized
 *     (one ahead), so there is no gap between clauses.
 *   - Audio is pushed in 20 ms frames as it streams from the provider; the first frame of an
 *     utterance plays while later ones are still arriving.
 *   - interrupt() (barge-in, TK-4459) aborts synthesis, drops queued audio and reports the
 *     text the caller actually heard.
 */

export interface TtsBinding {
  provider: TtsProvider;
  opts: TtsOptions;
}

interface Item {
  text: string;
  tts: TtsBinding;
  abort: AbortController;
  chunks: Int16Array[];
  rate: number;
  done: boolean;
  error: Error | null;
  wake: (() => void) | null;
  started: boolean;
  samplesTotal: number;
  samplesPlayed: number;
}

/** Linear resampler for PCM16 mono (TTS rate -> output rate). */
export function resample(pcm: Int16Array, from: number, to: number): Int16Array {
  if (from === to || pcm.length === 0) return pcm;
  const n = Math.max(1, Math.round((pcm.length * to) / from));
  const out = new Int16Array(n);
  const step = from / to;
  for (let i = 0; i < n; i++) {
    const x = i * step;
    const i0 = Math.floor(x);
    const i1 = Math.min(i0 + 1, pcm.length - 1);
    const f = x - i0;
    out[i] = Math.round(pcm[i0] * (1 - f) + pcm[i1] * f);
  }
  return out;
}

export class Speaker {
  private queue: Item[] = [];
  private playing: Item | null = null;
  private loop: Promise<void> | null = null;
  private idleWaiters: (() => void)[] = [];
  private firstAudioCb: ((at: number) => void) | null = null;
  private readonly frameSamples: number;
  private carry: Int16Array = new Int16Array(0);
  private generation = 0;

  constructor(private readonly source: AudioSource, private readonly outRate: number) {
    this.frameSamples = Math.round(outRate / 50);
  }

  /** Called once, with the time the next utterance's first audio frame was queued. */
  onFirstAudio(cb: (at: number) => void): void {
    this.firstAudioCb = cb;
  }

  get busy(): boolean {
    return this.playing !== null || this.queue.length > 0;
  }

  say(text: string, tts: TtsBinding): void {
    const clean = text.trim();
    if (!clean) return;
    const item: Item = {
      text: clean, tts, abort: new AbortController(), chunks: [], rate: tts.provider.sampleRate(tts.opts),
      done: false, error: null, wake: null, started: false, samplesTotal: 0, samplesPlayed: 0,
    };
    this.queue.push(item);
    this.prefetch();
    if (!this.loop) this.loop = this.run().finally(() => { this.loop = null; });
  }

  /** Starts synthesis for the playing item and the one after it. */
  private prefetch(): void {
    const window = [this.playing, ...this.queue].filter((x): x is Item => !!x).slice(0, 2);
    for (const item of window) {
      if (item.started) continue;
      item.started = true;
      void this.synthesize(item);
    }
  }

  private async synthesize(item: Item): Promise<void> {
    try {
      for await (const pcm of item.tts.provider.synthesize(item.text, item.tts.opts, item.abort.signal)) {
        if (item.abort.signal.aborted) break;
        item.chunks.push(pcm);
        item.samplesTotal += pcm.length;
        item.wake?.();
      }
    } catch (err) {
      item.error = err as Error;
    } finally {
      item.done = true;
      item.wake?.();
    }
  }

  private async run(): Promise<void> {
    while (this.queue.length > 0) {
      const item = this.queue.shift()!;
      this.playing = item;
      this.prefetch();
      const gen = this.generation;
      for (;;) {
        if (item.abort.signal.aborted || gen !== this.generation) break;
        const pcm = item.chunks.shift();
        if (pcm) {
          await this.play(resample(pcm, item.rate, this.outRate), item);
          continue;
        }
        if (item.done) break;
        await new Promise<void>((r) => { item.wake = r; });
        item.wake = null;
      }
      if (item.error && !item.abort.signal.aborted) {
        log.warn('tts failed for a clause', { provider: item.tts.provider.id, error: item.error.message });
      }
      this.playing = null;
    }
    await this.flushCarry();
    await this.source.waitForPlayout().catch(() => undefined);
    const w = this.idleWaiters;
    this.idleWaiters = [];
    for (const r of w) r();
  }

  private async play(pcm: Int16Array, item: Item): Promise<void> {
    let buf = this.carry.length ? concat(this.carry, pcm) : pcm;
    this.carry = new Int16Array(0);
    let off = 0;
    while (buf.length - off >= this.frameSamples) {
      if (item.abort.signal.aborted) return;
      const frame = buf.slice(off, off + this.frameSamples);
      off += this.frameSamples;
      if (this.firstAudioCb) {
        const cb = this.firstAudioCb;
        this.firstAudioCb = null;
        cb(Date.now());
      }
      await this.source.captureFrame(new AudioFrame(frame, this.outRate, 1, this.frameSamples));
      item.samplesPlayed += this.frameSamples;
    }
    buf = buf.slice(off);
    this.carry = buf;
  }

  private async flushCarry(): Promise<void> {
    if (!this.carry.length) return;
    const frame = new Int16Array(this.frameSamples);
    frame.set(this.carry.subarray(0, this.frameSamples));
    this.carry = new Int16Array(0);
    await this.source.captureFrame(new AudioFrame(frame, this.outRate, 1, this.frameSamples)).catch(() => undefined);
  }

  /** Resolves when everything queued has played out. */
  idle(): Promise<void> {
    if (!this.busy && !this.loop) return Promise.resolve();
    return new Promise((r) => this.idleWaiters.push(r));
  }

  /**
   * Barge-in: stop speaking now. Aborts synthesis, clears queued audio in the source, drops
   * pending clauses. Returns roughly what the caller heard of the interrupted utterance.
   */
  interrupt(): { heard: string; dropped: string } {
    this.generation += 1;
    const current = this.playing;
    const pending = this.queue;
    this.queue = [];
    let heard = '';
    if (current) {
      current.abort.abort();
      current.wake?.();
      const frac = current.samplesTotal > 0 ? Math.min(1, current.samplesPlayed / (current.samplesTotal * (this.outRate / current.rate))) : 0;
      const w = current.text.split(/\s+/);
      heard = w.slice(0, Math.round(w.length * frac)).join(' ');
    }
    for (const p of pending) p.abort.abort();
    this.carry = new Int16Array(0);
    this.source.clearQueue();
    const dropped = [current?.text.slice(heard.length) ?? '', ...pending.map((p) => p.text)].join(' ').trim();
    return { heard, dropped };
  }
}

function concat(a: Int16Array, b: Int16Array): Int16Array {
  const out = new Int16Array(a.length + b.length);
  out.set(a);
  out.set(b, a.length);
  return out;
}
