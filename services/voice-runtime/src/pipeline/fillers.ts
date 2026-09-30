/**
 * Latency-masking fillers (VA·E1 · TK-4463): a short acknowledgement ("One moment.") spoken
 * while a slow tool runs, so the caller is not left in dead air.
 *
 *   - Only when there is real latency: a tool whose recent latency is over FILLER_THRESHOLD_MS
 *     gets the filler as it starts; otherwise the filler is spoken only if the tools are
 *     still running once FILLER_THRESHOLD_MS has passed. Fast tools never produce one.
 *   - Not when the model already acknowledged in that round ("Let me check that for you").
 *   - Rate-limited per call: at most one every VOICE_FILLER_MIN_GAP_MS (default 8 s) and
 *     VOICE_FILLER_MAX_PER_CALL (default 6); consecutive fillers never repeat a phrase.
 */

export const FILLER_THRESHOLD_MS = 400;

const PHRASES: Record<string, string[]> = {
  en: ['One moment.', 'Let me check that.', 'Just a second.', 'Let me look that up.'],
  es: ['Un momento.', 'Déjeme verificarlo.', 'Un segundo, por favor.'],
  fr: ['Un instant.', 'Je vérifie.', 'Une seconde, s\'il vous plaît.'],
  de: ['Einen Moment.', 'Ich schaue kurz nach.', 'Eine Sekunde bitte.'],
  pt: ['Um momento.', 'Deixe-me verificar.', 'Só um segundo.'],
  it: ['Un momento.', 'Controllo subito.', 'Un secondo, per favore.'],
  nl: ['Een moment.', 'Ik kijk het even na.', 'Eén seconde.'],
};

export class FillerPolicy {
  private count = 0;
  private lastAt = 0;
  private lastPhrase = -1;
  private readonly minGapMs = Number(process.env.VOICE_FILLER_MIN_GAP_MS ?? 8000);
  private readonly maxPerCall = Number(process.env.VOICE_FILLER_MAX_PER_CALL ?? 6);
  private readonly phrases: string[];

  constructor(language: string | undefined) {
    const base = String(language || 'en').toLowerCase().split(/[-_]/)[0];
    this.phrases = PHRASES[base] ?? PHRASES.en;
  }

  /** Why a filler may not be spoken now, or null when it may. */
  blocked(now = Date.now()): 'rate_limited' | 'call_limit' | null {
    if (this.count >= this.maxPerCall) return 'call_limit';
    if (this.lastAt && now - this.lastAt < this.minGapMs) return 'rate_limited';
    return null;
  }

  /** Takes the next phrase (never the same as the previous one) and records its use. */
  take(now = Date.now()): string {
    let i = (this.lastPhrase + 1 + Math.floor(Math.random() * Math.max(1, this.phrases.length - 1))) % this.phrases.length;
    if (i === this.lastPhrase) i = (i + 1) % this.phrases.length;
    this.lastPhrase = i;
    this.count += 1;
    this.lastAt = now;
    return this.phrases[i];
  }
}
