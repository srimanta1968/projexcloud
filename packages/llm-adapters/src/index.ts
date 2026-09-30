/**
 * @projexlight/llm-adapters — stateless LLM provider adapters (VA·E5, extracted for VA·E1).
 *
 * Pure HTTP + streaming: no database, no provider registry, no routing. sdk-ai-gateway
 * registers these into its registry and adds retry/circuit/billing; services/voice-runtime
 * calls them directly with the key handles from the call bootstrap, so the voice hot path
 * never touches Postgres (VA-ADR-8).
 */
export type { ProviderAdapter, ProviderCompletionResult, StreamOptions } from './providerAdapter';
export { setModelPriceResolver, providerCost } from './modelPricing';
export type { ModelPrice, ModelPriceResolver } from './modelPricing';
export { makeOpenAiCompatibleAdapter, OPENAI_COMPATIBLE_BASE_URLS } from './adapters/openaiCompatible';
export type { OpenAiCompatibleOptions } from './adapters/openaiCompatible';
export { makeAnthropicAdapter } from './adapters/anthropic';
export type { AnthropicOptions } from './adapters/anthropic';
export { makeGeminiAdapter } from './adapters/gemini';
export type { GeminiOptions } from './adapters/gemini';
export { makeBedrockAdapter, bedrockAuth } from './adapters/bedrock';
export type { BedrockOptions } from './adapters/bedrock';
export { signV4 } from './adapters/sigv4';
export type { AwsCredentials } from './adapters/sigv4';
export { eventStreamMessages, encodeEventStreamMessage } from './adapters/eventStream';
export { ProviderHttpError, credentialKey, chatMessages, parseArgs, postJson, sseData } from './adapters/http';
