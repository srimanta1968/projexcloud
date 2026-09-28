/**
 * The BYOK preset stacks a tenant clones into a stack profile (VA·E2, TK-4469).
 *
 * A preset is catalogue data, not tenant data: it names a provider + model per layer and
 * the layers that need a tenant credential. Prices are indicative list prices per
 * call-minute (docs/v3.1/voiceagent/VoiceAgent-Architecture-v3.1.html §8); the live,
 * operator-editable catalogue lands with sdk-speech (VA·E4). realtime and private are
 * accepted by the schema but not offered until P4, so they are not listed here.
 */

export const VOICE_LAYERS = ['telephony', 'stt', 'llm_fast', 'llm_complex', 'tts'] as const;
export type VoiceLayer = (typeof VOICE_LAYERS)[number];

export const PRESET_KEYS = ['budget', 'balanced', 'premium'] as const;
export type PresetKey = (typeof PRESET_KEYS)[number];

/** One layer's provider choice. `options` carries provider-specific knobs (endpointing, speed…). */
export interface LayerConfig {
  provider: string;
  model?: string;
  voice?: string;
  options?: Record<string, unknown>;
}

export type LayerMap = Record<VoiceLayer, LayerConfig>;

export interface VoicePreset {
  key: PresetKey;
  name: string;
  description: string;
  layers: LayerMap;
  /** Layers a stack profile must hold a primary credential for before it is `complete`. */
  required_credential_layers: VoiceLayer[];
  /** Indicative provider spend per call-minute in USD, paid by the tenant to its providers. */
  estimated_cost_per_min: { low: number; high: number };
}

export const VOICE_PRESETS: readonly VoicePreset[] = [
  {
    key: 'budget',
    name: 'Budget',
    description: 'Lowest cost per minute for high-volume FAQ, reminders and simple outbound.',
    layers: {
      telephony: { provider: 'telnyx' },
      stt: { provider: 'assemblyai', model: 'universal-streaming' },
      llm_fast: { provider: 'groq', model: 'llama-3.1-8b-instant' },
      llm_complex: { provider: 'openai', model: 'gpt-4.1-mini' },
      tts: { provider: 'openai', model: 'gpt-4o-mini-tts', voice: 'alloy' },
    },
    required_credential_layers: [...VOICE_LAYERS],
    estimated_cost_per_min: { low: 0.017, high: 0.025 },
  },
  {
    key: 'balanced',
    name: 'Balanced',
    description: 'Default for CRM inbound and outbound: booking, qualification, support.',
    layers: {
      telephony: { provider: 'twilio' },
      stt: { provider: 'deepgram', model: 'nova-3' },
      llm_fast: { provider: 'openai', model: 'gpt-4.1-mini' },
      llm_complex: { provider: 'anthropic', model: 'claude-haiku-4-5' },
      tts: { provider: 'cartesia', model: 'sonic-2' },
    },
    required_credential_layers: [...VOICE_LAYERS],
    estimated_cost_per_min: { low: 0.035, high: 0.045 },
  },
  {
    key: 'premium',
    name: 'Premium',
    description: 'Highest quality for high-value sales and complex support.',
    layers: {
      telephony: { provider: 'twilio' },
      stt: { provider: 'deepgram', model: 'nova-3' },
      llm_fast: { provider: 'openai', model: 'gpt-4.1-mini' },
      llm_complex: { provider: 'anthropic', model: 'claude-sonnet-5' },
      tts: { provider: 'elevenlabs', model: 'eleven_flash_v2_5' },
    },
    required_credential_layers: [...VOICE_LAYERS],
    estimated_cost_per_min: { low: 0.08, high: 0.1 },
  },
];

/** The preset for a key, or undefined when the key is not an offered preset. */
export function findPreset(key: string): VoicePreset | undefined {
  return VOICE_PRESETS.find((p) => p.key === key);
}

/** True when `key` names a voice layer. */
export function isVoiceLayer(key: string): key is VoiceLayer {
  return (VOICE_LAYERS as readonly string[]).includes(key);
}
