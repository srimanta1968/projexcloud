import { registerProvider } from '../providerAdapter';
import { makeOpenAiCompatibleAdapter, OPENAI_COMPATIBLE_BASE_URLS } from './openaiCompatible';

/**
 * Real provider adapters (VA·E5). Registered at boot, BEFORE bootstrapLLMCredentials, so
 * the synthetic dev adapter is only installed where no real one exists.
 *
 * AI_GATEWAY_PROVIDER_MODE = real | synthetic. Default: real in production, synthetic
 * elsewhere, so a local stack never calls a vendor unless asked to.
 * AI_GATEWAY_OPENAI_BASE_URL points the openai provider at any OpenAI-compatible API root
 * (Azure OpenAI's compatible endpoint, a proxy, a tenant vLLM); AI_GATEWAY_OPENAI_AUTH=api-key
 * sends the key as `api-key` (Azure) instead of a bearer token.
 */
export function realProviderAdaptersEnabled(): boolean {
  const mode = process.env.AI_GATEWAY_PROVIDER_MODE;
  if (mode === 'real') return true;
  if (mode === 'synthetic') return false;
  return process.env.NODE_ENV === 'production';
}

/** Registers every real adapter; returns the provider ids registered. */
export function registerRealProviderAdapters(): string[] {
  const registered: string[] = [];
  registerProvider(makeOpenAiCompatibleAdapter({
    provider_id: 'openai',
    base_url: process.env.AI_GATEWAY_OPENAI_BASE_URL || OPENAI_COMPATIBLE_BASE_URLS.openai,
    auth: process.env.AI_GATEWAY_OPENAI_AUTH === 'api-key' ? 'api-key' : 'bearer',
  }));
  registered.push('openai');
  return registered;
}

export { makeOpenAiCompatibleAdapter, OPENAI_COMPATIBLE_BASE_URLS } from './openaiCompatible';
export type { OpenAiCompatibleOptions } from './openaiCompatible';
export { ProviderHttpError } from './http';
