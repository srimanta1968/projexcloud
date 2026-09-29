import { CredentialUnavailableError, withTenantCredentialKey } from '@projexlight/sdk-ai-gateway';
import { findCatalogEntries, listCatalog } from './catalogService';
import { SpeechError, conflict, notFound, validationError } from '../models/errors';

/**
 * Voice preview (VA·E4 · TK-4492): speaks a short text with one of the tenant's own TTS
 * keys, so a tenant hears a voice before choosing it. The request goes straight to the
 * provider with the tenant's key — nothing is billed by the platform (BYOK).
 *
 * The raw key only lives inside withTenantCredentialKey's callback; provider failures map
 * to typed errors whose messages never include the key or the provider URL. Provider API
 * roots can be redirected with SPEECH_PROBE_URL_<PROVIDER>, like the key probes.
 */

export const MAX_PREVIEW_CHARS = 300;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const previewTimeoutMs = (): number => Number(process.env.SPEECH_PREVIEW_TIMEOUT_MS ?? 15000);

function baseUrl(provider: string, fallback: string): string {
  return process.env[`SPEECH_PROBE_URL_${provider.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`] ?? fallback;
}

export interface PreviewInput {
  binding_id?: unknown;
  text?: unknown;
  voice?: unknown;
  model?: unknown;
  language?: unknown;
}

export interface VoicePreview {
  provider_id: string;
  model: string;
  voice: string;
  characters: number;
  content_type: string;
  audio_base64: string;
  /** List-price cost of this preview in USD, when the catalog prices the model per character. */
  estimated_cost: number | null;
}

interface SynthesisRequest {
  url: string;
  headers: Record<string, string>;
  body: unknown;
}

type Synthesizer = (key: string, model: string, voice: string, text: string, language: string) => SynthesisRequest;

const SYNTHESIZERS: Record<string, { defaultVoice?: string; build: Synthesizer }> = {
  openai: {
    defaultVoice: 'alloy',
    build: (key, model, voice, text) => ({
      url: `${baseUrl('openai', 'https://api.openai.com/v1')}/audio/speech`,
      headers: { Authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      body: { model, voice, input: text, response_format: 'mp3' },
    }),
  },
  elevenlabs: {
    defaultVoice: '21m00Tcm4TlvDq8ikWAM',
    build: (key, model, voice, text) => ({
      url: `${baseUrl('elevenlabs', 'https://api.elevenlabs.io/v1')}/text-to-speech/${encodeURIComponent(voice)}?output_format=mp3_44100_128`,
      headers: { 'xi-api-key': key, 'content-type': 'application/json' },
      body: { text, model_id: model },
    }),
  },
  cartesia: {
    build: (key, model, voice, text, language) => ({
      url: `${baseUrl('cartesia', 'https://api.cartesia.ai')}/tts/bytes`,
      headers: { 'X-API-Key': key, 'Cartesia-Version': '2024-06-10', 'content-type': 'application/json' },
      body: {
        model_id: model,
        transcript: text,
        voice: { mode: 'id', id: voice },
        language,
        output_format: { container: 'mp3', sample_rate: 44100, bit_rate: 128000 },
      },
    }),
  },
  deepgram: {
    defaultVoice: 'aura-2-thalia-en',
    // Deepgram Aura selects the voice through the model name.
    build: (key, _model, voice, text) => ({
      url: `${baseUrl('deepgram', 'https://api.deepgram.com/v1')}/speak?model=${encodeURIComponent(voice)}&encoding=mp3`,
      headers: { Authorization: `Token ${key}`, 'content-type': 'application/json' },
      body: { text },
    }),
  },
};

const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim().length > 0 ? v.trim() : undefined);

/**
 * Speaks `text` with the tenant's TTS key.
 *
 * @throws SpeechError 400 invalid input / not a TTS key / unsupported provider,
 *   404 unknown or another tenant's binding, 409 revoked, 422 key rejected by the
 *   provider, 429 provider throttled, 502 provider failure.
 */
export async function previewVoice(tenantId: string, input: PreviewInput): Promise<VoicePreview> {
  const bindingId = str(input.binding_id);
  if (!bindingId || !UUID_RE.test(bindingId)) throw validationError('binding_id must be a uuid');
  const text = str(input.text);
  if (!text) throw validationError('text is required');
  if (text.length > MAX_PREVIEW_CHARS) throw validationError(`text must be at most ${MAX_PREVIEW_CHARS} characters`);
  const language = str(input.language) ?? 'en';
  if (!/^[a-z]{2}(-[A-Za-z]{2})?$/.test(language)) throw validationError('language must be a language code such as en or pt-BR');

  try {
    return await withTenantCredentialKey(tenantId, bindingId, async (key, binding) => {
      if (binding.layer !== 'tts') throw validationError(`binding ${bindingId} is a ${binding.layer} key, not a tts key`);
      const synth = SYNTHESIZERS[binding.provider_id];
      if (!synth) throw validationError(`voice preview is not available for ${binding.provider_id}`);

      // Model: as given, else the provider's certified catalog TTS entry (else any entry).
      const tts = (await listCatalog({ layer: 'tts', provider: binding.provider_id })).sort((a, b) => Number(b.certified) - Number(a.certified));
      const model = str(input.model) ?? tts[0]?.model;
      if (!model) throw validationError(`no TTS model is catalogued for ${binding.provider_id}; pass model`);
      const entry = (await findCatalogEntries([`tts:${binding.provider_id}:${model}`])).get(`tts:${binding.provider_id}:${model}`);
      const voice = str(input.voice) ?? entry?.voices[0]?.id ?? synth.defaultVoice;
      if (!voice) throw validationError(`voice is required for ${binding.provider_id}`);

      const req = synth.build(key, model, voice, text, language);
      let res: Response;
      try {
        res = await fetch(req.url, { method: 'POST', headers: req.headers, body: JSON.stringify(req.body), signal: AbortSignal.timeout(previewTimeoutMs()) });
      } catch (err) {
        const timedOut = (err as Error)?.name === 'TimeoutError';
        throw new SpeechError(502, 'ProviderError', timedOut ? 'provider did not answer in time' : 'could not reach provider');
      }
      if (!res.ok) {
        await res.arrayBuffer().catch(() => undefined);
        if (res.status === 401 || res.status === 403) throw new SpeechError(422, 'KeyRejected', `provider rejected the key (HTTP ${res.status})`);
        if (res.status === 429) throw new SpeechError(429, 'RateLimited', 'provider rate-limited the preview (HTTP 429)');
        if (res.status === 400 || res.status === 404 || res.status === 422) {
          throw validationError(`provider refused the request (HTTP ${res.status}); check model and voice`);
        }
        throw new SpeechError(502, 'ProviderError', `provider answered HTTP ${res.status}`);
      }
      const audio = Buffer.from(await res.arrayBuffer());
      if (audio.length === 0) throw new SpeechError(502, 'ProviderError', 'provider returned no audio');
      return {
        provider_id: binding.provider_id,
        model,
        voice,
        characters: text.length,
        content_type: res.headers.get('content-type')?.split(';')[0] || 'audio/mpeg',
        audio_base64: audio.toString('base64'),
        estimated_cost: entry?.unit === 'per_1k_chars' ? Math.round((text.length / 1000) * entry.list_price * 1e6) / 1e6 : null,
      };
    });
  } catch (err) {
    if (err instanceof CredentialUnavailableError) {
      throw err.reason === 'revoked' ? conflict('credential binding is revoked') : notFound('credential binding not found');
    }
    throw err;
  }
}
