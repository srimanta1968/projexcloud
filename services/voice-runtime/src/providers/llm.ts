import {
  makeAnthropicAdapter,
  makeBedrockAdapter,
  makeGeminiAdapter,
  makeOpenAiCompatibleAdapter,
  OPENAI_COMPATIBLE_BASE_URLS,
  type ProviderAdapter,
} from '@projexlight/llm-adapters';
import { ProviderError, providerUrl } from './types';

/**
 * LLM adapters for turns (VA·E1 · TK-4458): the same stateless adapters sdk-ai-gateway
 * registers (@projexlight/llm-adapters), called in-process with the call's key handle so a
 * turn never goes through the gateway or Postgres. One adapter instance per provider id.
 */

const cache = new Map<string, ProviderAdapter>();

export function llmAdapter(provider: string): ProviderAdapter {
  const hit = cache.get(provider);
  if (hit) return hit;
  let a: ProviderAdapter;
  if (provider === 'anthropic') {
    a = makeAnthropicAdapter({ base_url: providerUrl('anthropic', 'https://api.anthropic.com/v1') });
  } else if (provider === 'gemini') {
    a = makeGeminiAdapter({ base_url: providerUrl('gemini', 'https://generativelanguage.googleapis.com/v1beta') });
  } else if (provider === 'bedrock') {
    a = makeBedrockAdapter({ region: process.env.VOICE_BEDROCK_REGION || 'us-east-1', base_url: process.env.VOICE_PROVIDER_URL_BEDROCK || undefined });
  } else if (OPENAI_COMPATIBLE_BASE_URLS[provider]) {
    a = makeOpenAiCompatibleAdapter({ provider_id: provider, base_url: providerUrl(provider, OPENAI_COMPATIBLE_BASE_URLS[provider]) });
  } else {
    throw new ProviderError(provider, 400, `LLM provider ${provider} is not supported by the voice runtime`);
  }
  cache.set(provider, a);
  return a;
}
