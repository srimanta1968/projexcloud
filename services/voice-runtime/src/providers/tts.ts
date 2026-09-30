import { Pcm16Decoder, ProviderError, providerUrl, type TtsOptions, type TtsProvider } from './types';

/**
 * Streaming text-to-speech (VA·E1 · TK-4458). Each provider is asked for raw PCM16 mono and
 * the HTTP response body is decoded as it arrives, so the first audio frame plays while
 * the rest of the clause is still being synthesized. Aborting the signal cancels the body.
 */

const TIMEOUT_MS = (): number => Number(process.env.VOICE_TTS_TIMEOUT_MS ?? 15000);

async function* streamPcm(provider: string, url: string, init: RequestInit, signal: AbortSignal): AsyncIterable<Int16Array> {
  let res: Response;
  try {
    res = await fetch(url, { ...init, signal: AbortSignal.any([signal, AbortSignal.timeout(TIMEOUT_MS())]) });
  } catch (err) {
    if (signal.aborted) return;
    throw new ProviderError(provider, 0, `could not reach ${provider}: ${(err as Error).message}`);
  }
  if (!res.ok || !res.body) {
    const text = await res.text().catch(() => '');
    throw new ProviderError(provider, res.status, `${provider} answered HTTP ${res.status}: ${text.slice(0, 200)}`);
  }
  const reader = res.body.getReader();
  const dec = new Pcm16Decoder();
  try {
    for (;;) {
      let chunk: Awaited<ReturnType<typeof reader.read>>;
      try {
        chunk = await reader.read();
      } catch (err) {
        if (signal.aborted) return;
        throw new ProviderError(provider, 0, `${provider} audio stream broke: ${(err as Error).message}`);
      }
      if (chunk.done) return;
      const pcm = dec.push(chunk.value);
      if (pcm.length) yield pcm;
    }
  } finally {
    // Stops the download when the consumer stops early (barge-in) or aborts.
    reader.cancel().catch(() => undefined);
  }
}

const rateOf = (opts: TtsOptions, fallback: number): number => {
  const r = Number(opts.options?.sample_rate);
  return Number.isInteger(r) && r >= 8000 ? r : fallback;
};

/** Cartesia Sonic: POST /tts/bytes, raw pcm_s16le. */
export const cartesiaTts: TtsProvider = {
  id: 'cartesia',
  sampleRate: (o) => rateOf(o, 24000),
  synthesize(text, o, signal) {
    return streamPcm('cartesia', `${providerUrl('cartesia', 'https://api.cartesia.ai')}/tts/bytes`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'X-API-Key': o.key, 'Cartesia-Version': '2024-06-10' },
      body: JSON.stringify({
        model_id: o.model || 'sonic-2',
        transcript: text,
        voice: { mode: 'id', id: o.voice || String(o.options?.voice_id ?? 'a0e99841-438c-4a64-b679-ae501e7d6091') },
        output_format: { container: 'raw', encoding: 'pcm_s16le', sample_rate: cartesiaTts.sampleRate(o) },
        language: o.language.slice(0, 2),
      }),
    }, signal);
  },
};

/** ElevenLabs: POST /v1/text-to-speech/{voice}/stream?output_format=pcm_<rate>. */
export const elevenLabsTts: TtsProvider = {
  id: 'elevenlabs',
  sampleRate: (o) => rateOf(o, 16000),
  synthesize(text, o, signal) {
    const voice = encodeURIComponent(o.voice || String(o.options?.voice_id ?? '21m00Tcm4TlvDq8ikWAM'));
    return streamPcm('elevenlabs', `${providerUrl('elevenlabs', 'https://api.elevenlabs.io')}/v1/text-to-speech/${voice}/stream?output_format=pcm_${elevenLabsTts.sampleRate(o)}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'xi-api-key': o.key },
      body: JSON.stringify({ text, model_id: o.model || 'eleven_flash_v2_5' }),
    }, signal);
  },
};

/** OpenAI speech: POST /v1/audio/speech, response_format=pcm (24 kHz). */
export const openAiTts: TtsProvider = {
  id: 'openai',
  sampleRate: () => 24000,
  synthesize(text, o, signal) {
    return streamPcm('openai', `${providerUrl('openai', 'https://api.openai.com/v1')}/audio/speech`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', Authorization: `Bearer ${o.key}` },
      body: JSON.stringify({ model: o.model || 'gpt-4o-mini-tts', voice: o.voice || 'alloy', input: text, response_format: 'pcm' }),
    }, signal);
  },
};

/** Deepgram Aura: POST /v1/speak?encoding=linear16&container=none. */
export const deepgramTts: TtsProvider = {
  id: 'deepgram',
  sampleRate: (o) => rateOf(o, 24000),
  synthesize(text, o, signal) {
    const q = new URLSearchParams({ model: o.model || o.voice || 'aura-2-thalia-en', encoding: 'linear16', sample_rate: String(deepgramTts.sampleRate(o)), container: 'none' });
    return streamPcm('deepgram', `${providerUrl('deepgram', 'https://api.deepgram.com')}/v1/speak?${q}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', Authorization: `Token ${o.key}` },
      body: JSON.stringify({ text }),
    }, signal);
  },
};

const TTS: Record<string, TtsProvider> = { cartesia: cartesiaTts, elevenlabs: elevenLabsTts, openai: openAiTts, deepgram: deepgramTts };

export function registerTtsProvider(p: TtsProvider): void {
  TTS[p.id] = p;
}

export function ttsProvider(id: string): TtsProvider {
  const p = TTS[id];
  if (!p) throw new ProviderError(id, 400, `text-to-speech provider ${id} is not supported by the voice runtime`);
  return p;
}
