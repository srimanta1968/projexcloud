import { describe, expect, it } from 'vitest';
import { ClauseChunker } from '../src/pipeline/chunker';
import { resample } from '../src/pipeline/speaker';

/** Feeds text as a model would: token by token. */
function run(text: string): string[] {
  const c = new ClauseChunker();
  const out: string[] = [];
  for (const tok of text.match(/\S+\s*/g) ?? []) out.push(...c.push(tok));
  out.push(...c.flush());
  return out;
}

describe('ClauseChunker', () => {
  it('cuts speakable clauses: early short first clause, sentence-bounded rest, safe boundaries', () => {
    // First clause at the first boundary once it has >= 2 words ("Sure," alone is too short);
    // later chunks at sentence ends, or at a clause boundary once they reach 8 words.
    expect(run('Sure, I can help with that. For two people tonight I have a table at seven, or one at eight thirty. Which would you prefer?'))
      .toEqual(['Sure, I can help with that.', 'For two people tonight I have a table at seven,', 'or one at eight thirty.', 'Which would you prefer?']);
    // A first clause with no punctuation is cut at 12 words, so TTS can start.
    const long = run('one two three four five six seven eight nine ten eleven twelve thirteen fourteen.');
    expect(long[0].split(' ')).toHaveLength(12);
    expect(long.join(' ')).toBe('one two three four five six seven eight nine ten eleven twelve thirteen fourteen.');
    // Decimals, abbreviations and a one-word first clause do not cut early.
    expect(run('Yes, Dr. Smith can see you at 3.30 today. Anything else?')).toEqual(['Yes, Dr. Smith can see you at 3.30 today.', 'Anything else?']);
    // Nothing is lost or reordered, whatever the token boundaries.
    const text = 'Okay. Your order number is 4512, placed on March 3rd; it ships tomorrow and should arrive by Friday — unless the courier is delayed by weather, which is rare.';
    expect(run(text).join(' ')).toBe(text);
    // Resampling keeps duration: 24 kHz -> 16 kHz is two thirds the samples.
    expect(resample(new Int16Array(2400), 24000, 16000)).toHaveLength(1600);
  });
});
