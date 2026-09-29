import { registerProvider } from '../providerAdapter';
import { makeOpenAiCompatibleAdapter, OPENAI_COMPATIBLE_BASE_URLS } from './openaiCompatible';
import { makeAnthropicAdapter } from './anthropic';
import { makeGeminiAdapter } from './gemini';
import { makeBedrockAdapter } from './bedrock';

/**
 * Real provider adapters (VA·E5). Registered at boot, BEFORE bootstrapLLMCredentials, so
 * the synthetic dev adapter is only installed where no real one exists.
 *
 * AI_GATEWAY_PROVIDER_MODE = real | synthetic. Default: real in production, synthetic
 * elsewhere, so a local stack never calls a vendor unless asked to.
 * AI_GATEWAY_OPENAI_BASE_URL points the openai provider at any OpenAI-compatible API root
 * (Azure OpenAI's compatible endpoint, a proxy, a tenant vLLM); AI_GATEWAY_OPENAI_AUTH=api-key
 * sends the key as `api-key` (Azure) instead of a bearer token. AI_GATEWAY_ANTHROPIC_BASE_URL,
 * AI_GATEWAY_GEMINI_BASE_URL and AI_GATEWAY_BEDROCK_BASE_URL override the other roots;
 * AI_GATEWAY_BEDROCK_REGION picks the Bedrock region (default us-east-1).
 */
export function realProviderAdaptersEnabled(): boolean {
  const mode = process.env.AI_GATEWAY_PROVIDER_MODE;
  if (mode === 'real') return true;
  if (mode === 'synthetic') return false;
  return process.env.NODE_ENV === 'production';
}

/** Registers every real adapter; returns the provider ids registered. */
export function registerRealProviderAdapters(): string[] {
  registerProvider(makeOpenAiCompatibleAdapter({
    provider_id: 'openai',
    base_url: process.env.AI_GATEWAY_OPENAI_BASE_URL || OPENAI_COMPATIBLE_BASE_URLS.openai,
    auth: process.env.AI_GATEWAY_OPENAI_AUTH === 'api-key' ? 'api-key' : 'bearer',
  }));
  registerProvider(makeAnthropicAdapter({ base_url: process.env.AI_GATEWAY_ANTHROPIC_BASE_URL || 'https://api.anthropic.com/v1' }));
  registerProvider(makeGeminiAdapter({ base_url: process.env.AI_GATEWAY_GEMINI_BASE_URL || 'https://generativelanguage.googleapis.com/v1beta' }));
  registerProvider(makeBedrockAdapter({
    region: process.env.AI_GATEWAY_BEDROCK_REGION || 'us-east-1',
    base_url: process.env.AI_GATEWAY_BEDROCK_BASE_URL || undefined,
  }));
  return ['openai', 'anthropic', 'gemini', 'bedrock'];
}

export { makeOpenAiCompatibleAdapter, OPENAI_COMPATIBLE_BASE_URLS } from './openaiCompatible';
export type { OpenAiCompatibleOptions } from './openaiCompatible';
export { makeAnthropicAdapter } from './anthropic';
export type { AnthropicOptions } from './anthropic';
export { makeGeminiAdapter } from './gemini';
export type { GeminiOptions } from './gemini';
export { makeBedrockAdapter, bedrockAuth } from './bedrock';
export type { BedrockOptions } from './bedrock';
export { signV4 } from './sigv4';
export type { AwsCredentials } from './sigv4';
export { eventStreamMessages, encodeEventStreamMessage } from './eventStream';
export { ProviderHttpError } from './http';
