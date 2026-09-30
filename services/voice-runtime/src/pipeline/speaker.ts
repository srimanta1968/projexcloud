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
  /** Resolved when synthesis starts, so a clause queued before a failover uses the new binding. */
  resolveTts: () => TtsBinding;
  tts: TtsBinding | null;
  retried: boolean;
  abort: AbortController;
  chunks: Int16Array[];
  rate: number;
  done: boolean;
  error: Error | null;
  wake: (() => void) | null;
  started: boolean;
  samplesTotal: number;
  samplesPlayed: number;
  /** Resolves when this clause has finished playing (or was dropped). */
  settle: () => void;
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
  private errorCb: ((err: Error, provider: string | null) => boolean) | null = null;

  constructor(private readonly source: AudioSource, private readonly outRate: number) {
    this.frameSamples = Math.round(outRate / 50);
  }

  /** Called once, with the time the next utterance's first audio frame was queued. */
  onFirstAudio(cb: (at: number) => void): void {
    this.firstAudioCb = cb;
  }

  /**
   * Called when a clause fails to synthesize. Return true to retry it once (only when none of
   * its audio was played) — e.g. the TTS layer just failed over to its secondary (TK-4465).
   */
  onError(cb: (err: Error, provider: string | null) => boolean): void {
    this.errorCb = cb;
  }

  get busy(): boolean {
    return this.playing !== null || this.queue.length > 0;
  }

  /** Queues a clause; the promise resolves when it has played out (or was interrupted). */
  say(text: string, tts: TtsBinding | (() => TtsBinding)): Promise<void> {
    const clean = text.trim();
    if (!clean) return Promise.resolve();
    let settle!: () => void;
    const played = new Promise<void>((r) => { settle = r; });
    const item: Item = {
      text: clean, resolveTts: typeof tts === 'function' ? tts : () => tts, tts: null, retried: false,
      abort: new AbortController(), chunks: [], rate: this.outRate,
      done: false, error: null, wake: null, started: false, samplesTotal: 0, samplesPlayed: 0, settle,
    };
    this.queue.push(item);
    this.prefetch();
    if (!this.loop) this.loop = this.run().finally(() => { this.loop = null; });
    return played;
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
      const tts = item.resolveTts();
      item.tts = tts;
      item.rate = tts.provider.sampleRate(tts.opts);
      for await (const pcm of tts.provider.synthesize(item.text, tts.opts, item.abort.signal)) {
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
        if (!item.error || item.abort.signal.aborted) break;
        const provider = item.tts?.provider.id ?? null;
        log.warn('tts failed for a clause', { provider, error: item.error.message });
        const retry = this.errorCb?.(item.error, provider) === true;
        // Retry once, on whatever binding is current now, if the caller heard none of it.
        if (!retry || item.retried || item.samplesTotal > 0) break;
        item.retried = true;
        item.error = null;
        item.done = false;
        item.chunks = [];
        void this.synthesize(item);
      }
      this.playing = null;
      // The clause's last frames are still in the source queue: it has been HEARD only once
      // they play out. An interrupted clause settles at once (its queue was cleared).
      if (item.abort.signal.aborted) item.settle();
      else setTimeout(item.settle, this.source.queuedDuration);
    }
    await this.flushCarry();
    // Bounded: after clearQueue() (barge-in) a playout wait may never be signalled.
    await Promise.race([
      this.source.waitForPlayout().catch(() => undefined),
      new Promise((r) => setTimeout(r, this.source.queuedDuration + 250)),
    ]);
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
      // A capture blocked on a full queue must not outlive a barge-in's clearQueue().
      await untilAborted(this.source.captureFrame(new AudioFrame(frame, this.outRate, 1, this.frameSamples)), item.abort.signal);
      if (item.abort.signal.aborted) return;
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
    for (const p of pending) { p.abort.abort(); p.settle(); }
    this.carry = new Int16Array(0);
    this.source.clearQueue();
    const dropped = [current?.text.slice(heard.length) ?? '', ...pending.map((p) => p.text)].join(' ').trim();
    return { heard, dropped };
  }
}

/** Resolves with `p`, or as soon as `signal` aborts (the pending promise is abandoned). */
function untilAborted(p: Promise<void>, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const onAbort = (): void => resolve();
    signal.addEventListener('abort', onAbort, { once: true });
    p.then(resolve, resolve).finally(() => signal.removeEventListener('abort', onAbort));
  });
}

function concat(a: Int16Array, b: Int16Array): Int16Array {
  const out = new Int16Array(a.length + b.length);
  out.set(a);
  out.set(b, a.length);
  return out;
}
