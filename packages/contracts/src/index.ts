/**
 * @projexlight/contracts — shared types, event registry, schemas used across
 * all SDK packages. Per Architecture v3.1 §0, any cross-SDK type lives here.
 */

export * from './events';
export * from './audit';
export * from './identity';
export * from './stubs';
export * from './p6a-agent';
export * from './p6b-knowledge';
export * from './p7-field';
export * from './p8-deployment';
export * from './p10-security';
export * from './tool-manifest';
export * from './trace-context';

/**
 * `@cross_pool_sanctioned(reason)` - marker decorator recognized by the OC-5
 * lint rule. Apply to any function/method that legitimately spans more than
 * one tenant pool (the four sanctioned cases per Architecture §3A).
 */
export type CrossPoolReason = 'resolver' | 'dsar' | 'analytics' | 'lineage';
export function cross_pool_sanctioned(_reason: CrossPoolReason) {
  return function (_target: unknown, _ctx?: unknown): void {
    // marker only - the lint rule checks for the decorator's presence
  };
}
