/**
 * Provider list prices for completion cost (VA·E5 · TK-4493).
 *
 * Adapters turn provider-reported token usage into provider_cost with the resolver
 * installed here. The api-gateway wires it to the sdk-speech catalog (operator-editable
 * list prices); without a resolver, or for a model the resolver does not know, the cost
 * is recorded as 0 rather than guessed.
 */

export interface ModelPrice {
  /** USD per 1M input tokens. */
  input_per_1m: number;
  /** USD per 1M output tokens. */
  output_per_1m: number;
}

export type ModelPriceResolver = (provider_id: string, model: string) => Promise<ModelPrice | null>;

let resolver: ModelPriceResolver | null = null;

/** Installs the list-price source (the api-gateway wires the speech catalog). */
export function setModelPriceResolver(fn: ModelPriceResolver | null): void {
  resolver = fn;
}

/** USD cost of a call from its token usage; 0 when the price is unknown. */
export async function providerCost(provider_id: string, model: string, tokens_in: number, tokens_out: number): Promise<number> {
  if (!resolver) return 0;
  let price: ModelPrice | null = null;
  try {
    price = await resolver(provider_id, model);
  } catch {
    price = null;
  }
  if (!price) return 0;
  return Number(((tokens_in / 1e6) * price.input_per_1m + (tokens_out / 1e6) * price.output_per_1m).toFixed(8));
}
