/**
 * Clause chunker (VA·E1 · TK-4458): turns the LLM's token stream into speakable pieces so
 * TTS can start on the first clause while the model is still generating.
 *
 *   - The FIRST chunk goes out at the first clause boundary (, ; : — or sentence end) once
 *     it has a couple of words, and never later than FIRST_MAX_WORDS (12) words — then it is
 *     cut at a word boundary. Time-to-first-audio is dominated by this chunk.
 *   - Later chunks go out at sentence ends (. ! ?), or at a clause boundary once they are
 *     long enough, capped at LATER_MAX_WORDS so a run-on sentence still streams.
 *   - Decimal points, abbreviations like "Dr." and ellipses do not end a sentence.
 */

const FIRST_MAX_WORDS = 12;
const FIRST_MIN_WORDS = 2;
const LATER_CLAUSE_MIN_WORDS = 8;
const LATER_MAX_WORDS = 30;
const ABBREV = /\b(?:mr|mrs|ms|dr|st|jr|sr|vs|etc|e\.g|i\.e|no|approx|appt|dept|inc|ltd)\.$/i;

const words = (s: string): number => (s.trim() ? s.trim().split(/\s+/).length : 0);

export class ClauseChunker {
  private buf = '';
  private emitted = 0;

  constructor(private readonly firstMaxWords = FIRST_MAX_WORDS) {}

  /** Feeds a token delta; returns zero or more complete chunks, in order. */
  push(delta: string): string[] {
    this.buf += delta;
    const out: string[] = [];
    for (;;) {
      const cut = this.findCut();
      if (cut < 0) break;
      const chunk = this.buf.slice(0, cut).trim();
      this.buf = this.buf.slice(cut);
      if (chunk) {
        out.push(chunk);
        this.emitted += 1;
      }
    }
    return out;
  }

  /** The remainder once the model is done. */
  flush(): string[] {
    const rest = this.buf.trim();
    this.buf = '';
    if (!rest) return [];
    this.emitted += 1;
    return [rest];
  }

  /** Index to cut the buffer at, or -1 when no chunk is ready yet. */
  private findCut(): number {
    const first = this.emitted === 0;
    const s = this.buf;
    // Walk boundaries; a boundary only counts when followed by whitespace (so "3.5" and a
    // token that ends mid-number do not split).
    const re = /([.!?]+["')\]]?|[,;:—–])(\s)/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(s)) !== null) {
      const end = m.index + m[1].length;
      const head = s.slice(0, end);
      const n = words(head);
      const sentence = /[.!?]/.test(m[1][0]);
      if (sentence && ABBREV.test(head.trim())) continue;
      if (first) {
        if (n >= FIRST_MIN_WORDS && n <= this.firstMaxWords) return end;
        if (n > this.firstMaxWords) break;
      } else if (sentence || n >= LATER_CLAUSE_MIN_WORDS) {
        return end;
      }
    }
    // No usable boundary: force a cut at a word boundary once the chunk is long enough.
    const max = first ? this.firstMaxWords : LATER_MAX_WORDS;
    const tokens = s.match(/\S+\s+/g);
    if (tokens && tokens.length >= max) {
      let idx = 0;
      for (let i = 0; i < max; i++) idx += tokens[i].length;
      return idx;
    }
    return -1;
  }
}
