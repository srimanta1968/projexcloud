import { describe, expect, it } from 'vitest';
import type { ChatMessage, StreamChunk } from '@projexlight/contracts';
import type { ProviderAdapter } from '@projexlight/llm-adapters';
import { realProviders, type SessionProviders } from '../src/pipeline/voiceSession';
import type { SttProvider, Transcript, TtsProvider } from '../src/providers/types';
import { certifyLlm, certifyStt, certifyTts, wordErrorRate, type CertificationJob } from '../src/sim/certify';

const DIGITS: Record<string, string> = { zero: '0', one: '1', two: '2', three: '3', four: '4', five: '5', six: '6', seven: '7', eight: '8', nine: '9' };

const job = (layer: CertificationJob['layer'], thresholds: Record<string, number>, reference: CertificationJob['reference'] = null): CertificationJob => ({
  run_id: 'r1', layer, scope: 'tenant', thresholds, reference,
  subject: { provider: 'acme', model: 'm1', voice: null, language: 'en', key: 'k' },
});

describe('catalog certification (TK-4519)', () => {
  it('llm: scores tool-call accuracy on the spoken order number, latency and barge-in', async () => {
    // A model that uses the tool with the digits it heard — and one that gets the number wrong.
    const model = (garble: boolean) => ({
      provider_id: 'acme',
      async complete() { return { output: '', tool_calls: [], tokens_in: 0, tokens_out: 0, provider_cost: 0, finish_reason: 'stop' as const }; },
      async *stream(req: { prompt: ChatMessage[] | string }): AsyncIterable<StreamChunk> {
        const msgs = req.prompt as ChatMessage[];
        const last = msgs[msgs.length - 1];
        if (last.role === 'user' && /order/i.test(last.content)) {
          const digits = last.content.toLowerCase().split(/\W+/).map((w) => DIGITS[w] ?? '').join('');
          yield { completion_id: 'm', index: 0, delta: '', finish_reason: 'tool_call', tool_calls: [{ tool_call_id: 'c', tool_sku: 'lookup_order', args: { order_id: garble ? '1' : digits } }] };
          return;
        }
        const text = last.role === 'tool' ? 'It has shipped and arrives Friday.' : 'We sell tents, packs, stoves and boots, and you can return anything unused within thirty days for a full refund.';
        for (const w of text.split(/(\s+)/)) yield { completion_id: 'm', index: 0, delta: w };
        yield { completion_id: 'm', index: 1, delta: '', finish_reason: 'stop' };
      },
    }) as unknown as ProviderAdapter;
    const thresholds = { ttft_p95_ms: 1500, tool_accuracy_min: 0.9, barge_in_stop_ms: 250 };
    const good = await certifyLlm(job('llm', thresholds), { ...realProviders, llm: () => model(false) });
    expect(good.metrics.tool_accuracy).toBe(1);
    expect(good.passed).toBe(true);
    const bad = await certifyLlm(job('llm', thresholds), { ...realProviders, llm: () => model(true) });
    expect(bad.metrics.tool_accuracy).toBe(0);
    expect(bad.passed).toBe(false);
  }, 120_000);

  it('stt and tts: phone-band audio loopback scored on word error rate, latency and real-time factor', async () => {
    expect(wordErrorRate('Can you transfer me to billing please?', 'can you transfer me to billing please')).toBe(0);
    expect(wordErrorRate('one two three four', 'one two tree four')).toBe(0.25);

    const sentences = ['Can you transfer me to billing please?', 'Yes, that works for me.'];
    // Fake speech: audio of a plausible length; the "recogniser" returns what it is scripted to hear.
    const tts: TtsProvider = {
      id: 'faketts', sampleRate: () => 24000,
      synthesize: (text) => (async function* () { yield new Int16Array(Math.round(text.split(' ').length * 0.08 * 24000)).fill(3000); })(),
    };
    const heard: string[] = [];
    const stt: SttProvider = {
      id: 'fakestt',
      connect: async () => {
        let cb: (t: Transcript) => void = () => undefined;
        let silent = 0;
        let done = false;
        return {
          write: (pcm: Int16Array) => {
            if (done) return;
            silent = pcm.every((v) => v === 0) ? silent + 1 : 0;
            if (silent === 5) { done = true; cb({ text: heard.shift() ?? '', final: true, endOfTurn: true }); }
          },
          close: () => undefined, onTranscript: (f: (t: Transcript) => void) => { cb = f; }, onSpeechStart: () => undefined, onError: () => undefined,
        };
      },
    };
    const providers: SessionProviders = { ...realProviders, stt: () => stt, tts: () => tts };
    const ref = (layer: 'stt' | 'tts') => ({ layer, provider: 'ref', model: null, voice: null, key: 'k' });

    heard.push('can you transfer me to billing please', 'yes that works for me');
    const sttOk = await certifyStt(job('stt', { wer_max: 0.15, final_latency_p95_ms: 1200 }, ref('tts')), providers, sentences);
    expect(sttOk.metrics.wer_mean).toBe(0);
    expect(sttOk.passed).toBe(true);

    heard.push('can you transfer me', 'yes');
    const sttBad = await certifyStt(job('stt', { wer_max: 0.15, final_latency_p95_ms: 1200 }, ref('tts')), providers, sentences);
    expect(sttBad.passed).toBe(false);

    heard.push('can you transfer me to billing please', 'yes that works for me');
    const ttsOk = await certifyTts(job('tts', { ttfa_p95_ms: 800, rtf_max: 1, wer_max: 0.2 }, ref('stt')), providers, sentences);
    expect(ttsOk.metrics.silent_samples).toBe(0);
    expect(ttsOk.passed).toBe(true);
  }, 60_000);
});
