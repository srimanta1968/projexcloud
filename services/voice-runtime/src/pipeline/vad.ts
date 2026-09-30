/**
 * Voice activity detection (VA·E1 · TK-4459) on the caller's 16 kHz PCM, in 10 ms windows.
 *
 * An adaptive energy detector: it tracks the line's noise floor while nobody speaks and
 * calls a window "speech" when its RMS clears max(absolute floor, noise x multiplier).
 * Speech STARTS after `minSpeechMs` of consecutive speech windows (short clicks and pops
 * never qualify) and ENDS after `minSilenceMs` of consecutive non-speech. The start event
 * carries the time of the first speech window, so barge-in latency is measured from when
 * the caller actually began talking.
 *
 * Sensitivity is per agent (stack stt options.turn_detection.sensitivity): high reacts to
 * quieter, shorter speech (quiet rooms), low needs louder, longer speech (noisy lines,
 * speakerphones). A model-based VAD can replace this behind the same interface.
 */

export type Sensitivity = 'low' | 'medium' | 'high';

export interface VadConfig {
  sensitivity: Sensitivity;
  /** Consecutive speech needed to call it speech (barge-in trigger latency). */
  minSpeechMs: number;
  /** Consecutive silence that ends a speech segment. */
  minSilenceMs: number;
  sampleRate: number;
}

export type VadEvent =
  | { type: 'speech_start'; at: number }
  | { type: 'speech_end'; at: number };

const PRESET: Record<Sensitivity, { absMin: number; mult: number; minSpeechMs: number }> = {
  high: { absMin: 350, mult: 2.5, minSpeechMs: 40 },
  medium: { absMin: 600, mult: 3.5, minSpeechMs: 60 },
  low: { absMin: 1200, mult: 5, minSpeechMs: 100 },
};

export function vadConfig(sensitivity: unknown, overrides: { minSpeechMs?: unknown; minSilenceMs?: unknown } = {}, sampleRate = 16000): VadConfig {
  const s: Sensitivity = sensitivity === 'low' || sensitivity === 'high' ? sensitivity : 'medium';
  const num = (v: unknown, d: number): number => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : d);
  return { sensitivity: s, minSpeechMs: num(overrides.minSpeechMs, PRESET[s].minSpeechMs), minSilenceMs: num(overrides.minSilenceMs, 300), sampleRate };
}

export class EnergyVad {
  private readonly win: number;
  private readonly absMin: number;
  private readonly mult: number;
  private noise = 200;
  private speechRun = 0;
  private silenceRun = 0;
  private speaking = false;
  private runStartAt = 0;
  private pending = new Int16Array(0);

  constructor(private readonly cfg: VadConfig) {
    this.win = Math.round(cfg.sampleRate / 100);
    this.absMin = PRESET[cfg.sensitivity].absMin;
    this.mult = PRESET[cfg.sensitivity].mult;
  }

  get isSpeaking(): boolean {
    return this.speaking;
  }

  /** Feeds audio that ENDS at `endAt` (ms); returns speech start/end transitions. */
  push(pcm: Int16Array, endAt: number): VadEvent[] {
    let buf = pcm;
    if (this.pending.length) {
      buf = new Int16Array(this.pending.length + pcm.length);
      buf.set(this.pending);
      buf.set(pcm, this.pending.length);
    }
    const events: VadEvent[] = [];
    const windows = Math.floor(buf.length / this.win);
    for (let w = 0; w < windows; w++) {
      const off = w * this.win;
      let sum = 0;
      for (let i = off; i < off + this.win; i++) sum += buf[i] * buf[i];
      const rms = Math.sqrt(sum / this.win);
      // Time at the END of this window.
      const at = endAt - ((buf.length - (off + this.win)) / this.cfg.sampleRate) * 1000;
      const isSpeech = rms > Math.max(this.absMin, this.noise * this.mult);
      if (isSpeech) {
        if (this.speechRun === 0) this.runStartAt = at - 10;
        this.speechRun += 10;
        this.silenceRun = 0;
        if (!this.speaking && this.speechRun >= this.cfg.minSpeechMs) {
          this.speaking = true;
          events.push({ type: 'speech_start', at: this.runStartAt });
        }
      } else {
        // Only learn the floor from non-speech, so a long utterance does not raise it.
        this.noise = this.noise * 0.95 + rms * 0.05;
        this.speechRun = 0;
        this.silenceRun += 10;
        if (this.speaking && this.silenceRun >= this.cfg.minSilenceMs) {
          this.speaking = false;
          events.push({ type: 'speech_end', at: at - this.silenceRun });
        }
      }
    }
    this.pending = buf.slice(windows * this.win);
    return events;
  }
}
