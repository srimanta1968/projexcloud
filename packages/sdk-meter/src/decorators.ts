import { check, report } from './services/meterGate';
import type { MeterDimensions, GateDecision } from './services/meterGate';

/**
 * Metadata schema for the `@meter` decorator per FR-CTR-6 + FR-MET-6. In P1
 * we ship the decorator + a metadata registry that build-time codegen will
 * later read (P4+); the decorator itself wraps the method with the two-phase
 * gate so consumers can use it today.
 */
export interface MeterMetadata {
  sku: string;
  unit: 'call' | 'byte' | 'doc' | 'token' | 'GB-mo';
  tier: 'core' | 'premium';
  /** Optional resolver from method args to MeterDimensions */
  resolveDimensions?: (...args: unknown[]) => MeterDimensions;
}

const METADATA: Map<string, MeterMetadata> = new Map();

/**
 * Registers metadata for `ClassName.methodName`. The codegen pass uses this
 * registry to discover every metered method without scanning source.
 */
export function registerMeterMetadata(qualifiedName: string, meta: MeterMetadata): void {
  METADATA.set(qualifiedName, meta);
}

export function getMeterMetadata(qualifiedName: string): MeterMetadata | undefined {
  return METADATA.get(qualifiedName);
}

export function listMeterMetadata(): { qualifiedName: string; meta: MeterMetadata }[] {
  return Array.from(METADATA.entries()).map(([qualifiedName, meta]) => ({ qualifiedName, meta }));
}

/**
 * `@meter(sku, unit, tier)` method decorator per FR-MET-6 + AC-12. Wraps the
 * decorated async method with the two-phase gate: check() before, report()
 * after. Until build-time codegen lands, this runtime form is the canonical
 * way to instrument SDK methods.
 */
export function meter(sku: string, unit: MeterMetadata['unit'] = 'call', tier: MeterMetadata['tier'] = 'core') {
  return function <This, Args extends unknown[], Return>(
    target: (this: This, ...args: Args) => Promise<Return>,
    context: ClassMethodDecoratorContext<This, (this: This, ...args: Args) => Promise<Return>>,
  ): (this: This, ...args: Args) => Promise<Return> {
    const qualifiedName = String(context.name);
    registerMeterMetadata(qualifiedName, { sku, unit, tier });

    return async function (this: This, ...args: Args): Promise<Return> {
      const decision: GateDecision = (await check({ sku, tenant_id: null })).decision;
      if (decision === 'DENY') {
        throw new Error(`Meter gate DENY for ${sku}`);
      }
      try {
        const result = await target.apply(this, args);
        await report({
          sku,
          units: 1,
          dimensions: {
            org_id: null, app_id: null, tenant_id: null, bu_id: null,
            persona_id: null, encounter_id: null,
            pool_index: 'unknown', region: 'unknown',
            actor_kind: 'service', actor_id: 'sdk',
          },
        });
        return result;
      } catch (err) {
        throw err;
      }
    };
  };
}
