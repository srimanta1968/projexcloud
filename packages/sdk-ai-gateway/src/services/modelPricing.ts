/**
 * Provider list prices for completion cost (VA·E5 · TK-4493) — lives in
 * @projexlight/llm-adapters with the adapters that call it; re-exported here so the
 * api-gateway's setModelPriceResolver installs the resolver those adapters read.
 */
export { setModelPriceResolver, providerCost } from '@projexlight/llm-adapters';
export type { ModelPrice, ModelPriceResolver } from '@projexlight/llm-adapters';
