/**
 * P9 / E1.F2 — validateManifest + diffManifests.
 * Hand-rolled to keep the package zero-runtime-deps (Localize-Complexity
 * doctrine). Lints sit in lint.ts and are run AFTER schema pass.
 */

import {
  ConflictPolicy,
  ManifestChange,
  ManifestDiff,
  ManifestEvent,
  PoolPlacement,
  RetentionClass,
  SchemaVersion,
  SdkCapabilityManifest,
} from './types';
import { runLints } from './lint';

const POOL_PLACEMENTS: PoolPlacement[] = [
  'admin',
  'app',
  'evidence',
  'global-catalog',
  'warehouse',
  'vector',
  'olap',
];

const RETENTION_CLASSES: RetentionClass[] = ['transient', 'operational', 'regulated'];

const CONFLICT_POLICIES: ConflictPolicy[] = [
  'crdt',
  'lww',
  'merge',
  'event-sourcing',
  'human-review',
];

const HTTP_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] as const;

const SUPPORTED_SCHEMA_VERSIONS: SchemaVersion[] = ['1.0'];

export type ValidationResult =
  | { ok: true; value: SdkCapabilityManifest }
  | { ok: false; errors: string[] };

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === 'string');
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Validates an unknown JSON value against schema 1.0. Returns the typed
 * manifest on success or a structured error list on failure. Runs lints
 * AFTER schema validation passes — lint errors are surfaced the same way
 * as schema errors so CI treats them identically.
 */
export function validateManifest(input: unknown): ValidationResult {
  const errors: string[] = [];

  if (!isObject(input)) {
    return { ok: false, errors: ['manifest must be a JSON object'] };
  }

  const m = input as Record<string, unknown>;

  // schema_version
  if (typeof m.schema_version !== 'string') {
    errors.push('schema_version is required (string)');
  } else if (!SUPPORTED_SCHEMA_VERSIONS.includes(m.schema_version as SchemaVersion)) {
    errors.push(
      `schema_version "${m.schema_version}" is not supported; expected one of: ${SUPPORTED_SCHEMA_VERSIONS.join(', ')}`,
    );
  }

  // name + version
  if (typeof m.name !== 'string' || m.name.length === 0) {
    errors.push('name is required (non-empty string)');
  }
  if (typeof m.version !== 'string' || m.version.length === 0) {
    errors.push('version is required (non-empty string)');
  }

  // summary
  if (typeof m.summary !== 'string') {
    errors.push('summary is required (string)');
  }

  // tags
  if (!isStringArray(m.tags)) {
    errors.push('tags is required (string[])');
  }

  // pool_placement
  if (typeof m.pool_placement !== 'string') {
    errors.push('pool_placement is required (string)');
  } else if (!POOL_PLACEMENTS.includes(m.pool_placement as PoolPlacement)) {
    errors.push(
      `pool_placement "${m.pool_placement}" must be one of: ${POOL_PLACEMENTS.join(', ')}`,
    );
  }

  // provides
  if (!isObject(m.provides)) {
    errors.push('provides is required (object)');
  } else {
    const p = m.provides as Record<string, unknown>;
    errors.push(...validateProvides(p));
  }

  // consumes
  if (!isObject(m.consumes)) {
    errors.push('consumes is required (object)');
  } else {
    const c = m.consumes as Record<string, unknown>;
    errors.push(...validateConsumes(c));
  }

  // scenarios
  if (!Array.isArray(m.scenarios)) {
    errors.push('scenarios is required (array)');
  } else {
    errors.push(...validateScenarios(m.scenarios));
  }

  // compliance_posture
  if (!isObject(m.compliance_posture)) {
    errors.push('compliance_posture is required (object with regimes)');
  } else {
    const cp = m.compliance_posture as Record<string, unknown>;
    if (!isStringArray(cp.regimes)) {
      errors.push('compliance_posture.regimes is required (string[])');
    }
    if (cp.notes !== undefined && typeof cp.notes !== 'string') {
      errors.push('compliance_posture.notes must be a string if present');
    }
  }

  // pricing_skus
  if (!Array.isArray(m.pricing_skus)) {
    errors.push('pricing_skus is required (array; can be empty)');
  } else {
    errors.push(...validatePricingSkus(m.pricing_skus));
  }

  // links
  if (!isObject(m.links)) {
    errors.push('links is required (object; can be empty)');
  }

  // no_endpoints is optional bool
  if (m.no_endpoints !== undefined && typeof m.no_endpoints !== 'boolean') {
    errors.push('no_endpoints must be boolean if present');
  }

  if (errors.length > 0) return { ok: false, errors };

  // Schema pass — run lints next. Cast through unknown because we have
  // already validated every required field above.
  const value = input as unknown as SdkCapabilityManifest;
  const lintErrors = runLints(value);
  if (lintErrors.length > 0) return { ok: false, errors: lintErrors };

  return { ok: true, value };
}

function validateProvides(p: Record<string, unknown>): string[] {
  const errs: string[] = [];
  if (!Array.isArray(p.endpoints)) errs.push('provides.endpoints must be an array');
  else {
    for (const [i, ep] of p.endpoints.entries()) {
      if (!isObject(ep)) {
        errs.push(`provides.endpoints[${i}] must be an object`);
        continue;
      }
      if (!HTTP_METHODS.includes(ep.method as (typeof HTTP_METHODS)[number])) {
        errs.push(`provides.endpoints[${i}].method must be one of: ${HTTP_METHODS.join(', ')}`);
      }
      if (typeof ep.path !== 'string' || ep.path.length === 0) {
        errs.push(`provides.endpoints[${i}].path must be a non-empty string`);
      }
    }
  }

  if (!Array.isArray(p.events)) errs.push('provides.events must be an array');
  else {
    for (const [i, ev] of p.events.entries()) {
      if (!isObject(ev)) {
        errs.push(`provides.events[${i}] must be an object`);
        continue;
      }
      const evt = ev as Partial<ManifestEvent>;
      if (typeof evt.name !== 'string' || evt.name.length === 0) {
        errs.push(`provides.events[${i}].name is required`);
      }
      if (!RETENTION_CLASSES.includes(evt.retention_class as RetentionClass)) {
        errs.push(
          `provides.events[${i}].retention_class must be one of: ${RETENTION_CLASSES.join(', ')}`,
        );
      }
      if (!CONFLICT_POLICIES.includes(evt.conflict_policy as ConflictPolicy)) {
        errs.push(
          `provides.events[${i}].conflict_policy must be one of: ${CONFLICT_POLICIES.join(', ')}`,
        );
      }
    }
  }

  if (!Array.isArray(p.models)) errs.push('provides.models must be an array');
  if (!Array.isArray(p.hooks)) errs.push('provides.hooks must be an array');
  if (!Array.isArray(p.ui_components)) errs.push('provides.ui_components must be an array');
  return errs;
}

function validateConsumes(c: Record<string, unknown>): string[] {
  const errs: string[] = [];
  if (!Array.isArray(c.events)) errs.push('consumes.events must be an array');
  if (!isStringArray(c.infra)) errs.push('consumes.infra must be string[]');
  if (!isStringArray(c.config_keys)) errs.push('consumes.config_keys must be string[]');
  return errs;
}

function validateScenarios(scenarios: unknown[]): string[] {
  const errs: string[] = [];
  const seen = new Set<string>();
  for (const [i, s] of scenarios.entries()) {
    if (!isObject(s)) {
      errs.push(`scenarios[${i}] must be an object`);
      continue;
    }
    for (const field of ['id', 'title', 'when_to_use', 'example_code', 'expected_outcome']) {
      if (typeof (s as Record<string, unknown>)[field] !== 'string') {
        errs.push(`scenarios[${i}].${field} is required (string)`);
      }
    }
    const id = (s as Record<string, unknown>).id;
    if (typeof id === 'string') {
      if (seen.has(id)) errs.push(`scenarios[${i}].id "${id}" is duplicated`);
      seen.add(id);
    }
  }
  return errs;
}

function validatePricingSkus(skus: unknown[]): string[] {
  const errs: string[] = [];
  for (const [i, s] of skus.entries()) {
    if (!isObject(s)) {
      errs.push(`pricing_skus[${i}] must be an object`);
      continue;
    }
    const sku = s as Record<string, unknown>;
    if (typeof sku.sku !== 'string') errs.push(`pricing_skus[${i}].sku is required (string)`);
    if (!['flat', 'metered', 'subscription'].includes(sku.mode as string)) {
      errs.push(`pricing_skus[${i}].mode must be one of: flat, metered, subscription`);
    }
    if (typeof sku.unit_description !== 'string') {
      errs.push(`pricing_skus[${i}].unit_description is required (string)`);
    }
  }
  return errs;
}

/* ----------------------------------------------------------- diffManifests */

/**
 * Categorizes the difference between two manifests as added/removed/changed
 * across endpoints, events, models, hooks, scenarios, pool_placement,
 * pricing_skus, compliance_regimes. is_breaking is true when at least one
 * removal or signature-change is present.
 *
 * Used by:
 *   - CI gate (E1.F4) to warn on PRs that remove an event a consumer SDK
 *     declares in its consumes.events list.
 *   - Registry refresh (E3.F4) to invalidate cached client integrations
 *     when an upstream SDK ships a breaking manifest.
 */
export function diffManifests(
  a: SdkCapabilityManifest,
  b: SdkCapabilityManifest,
): ManifestDiff {
  const added: ManifestChange[] = [];
  const removed: ManifestChange[] = [];
  const changed: ManifestChange[] = [];

  // endpoints — keyed by `${method} ${path}`
  diffNamedSet(
    a.provides.endpoints.map((e) => [`${e.method} ${e.path}`, e] as const),
    b.provides.endpoints.map((e) => [`${e.method} ${e.path}`, e] as const),
    'endpoint',
    added,
    removed,
    changed,
  );

  // events — keyed by name
  diffNamedSet(
    a.provides.events.map((e) => [e.name, e] as const),
    b.provides.events.map((e) => [e.name, e] as const),
    'event',
    added,
    removed,
    changed,
  );

  // models — keyed by `${schema}.${table}`
  diffNamedSet(
    a.provides.models.map((m) => [`${m.schema}.${m.table}`, m] as const),
    b.provides.models.map((m) => [`${m.schema}.${m.table}`, m] as const),
    'model',
    added,
    removed,
    changed,
  );

  // hooks
  diffNamedSet(
    a.provides.hooks.map((h) => [h.name, h] as const),
    b.provides.hooks.map((h) => [h.name, h] as const),
    'hook',
    added,
    removed,
    changed,
  );

  // scenarios
  diffNamedSet(
    a.scenarios.map((s) => [s.id, s] as const),
    b.scenarios.map((s) => [s.id, s] as const),
    'scenario',
    added,
    removed,
    changed,
  );

  // pool_placement
  if (a.pool_placement !== b.pool_placement) {
    changed.push({
      kind: 'pool_placement',
      identifier: 'pool_placement',
      before: a.pool_placement,
      after: b.pool_placement,
      is_breaking: true,
    });
  }

  // pricing_skus — keyed by sku
  diffNamedSet(
    a.pricing_skus.map((s) => [s.sku, s] as const),
    b.pricing_skus.map((s) => [s.sku, s] as const),
    'pricing_sku',
    added,
    removed,
    changed,
  );

  // compliance regimes — set diff
  const aRegimes = new Set(a.compliance_posture.regimes);
  const bRegimes = new Set(b.compliance_posture.regimes);
  for (const r of aRegimes) {
    if (!bRegimes.has(r)) {
      removed.push({ kind: 'compliance_regime', identifier: r, before: r, is_breaking: true });
    }
  }
  for (const r of bRegimes) {
    if (!aRegimes.has(r)) {
      added.push({ kind: 'compliance_regime', identifier: r, after: r, is_breaking: false });
    }
  }

  const is_breaking =
    removed.length > 0 || changed.some((c) => c.is_breaking);

  return { added, removed, changed, is_breaking };
}

function diffNamedSet<T>(
  before: ReadonlyArray<readonly [string, T]>,
  after: ReadonlyArray<readonly [string, T]>,
  kind: ManifestChange['kind'],
  added: ManifestChange[],
  removed: ManifestChange[],
  changed: ManifestChange[],
): void {
  const a = new Map(before);
  const b = new Map(after);

  for (const [id, val] of a) {
    if (!b.has(id)) {
      removed.push({ kind, identifier: id, before: val, is_breaking: true });
    } else {
      const after = b.get(id)!;
      if (JSON.stringify(val) !== JSON.stringify(after)) {
        changed.push({ kind, identifier: id, before: val, after, is_breaking: true });
      }
    }
  }
  for (const [id, val] of b) {
    if (!a.has(id)) {
      added.push({ kind, identifier: id, after: val, is_breaking: false });
    }
  }
}
