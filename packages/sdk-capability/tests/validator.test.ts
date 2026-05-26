import { describe, expect, it } from 'vitest';
import { validateManifest } from '../src/validator';
import { validManifest } from './fixtures';

describe('validateManifest — happy path', () => {
  it('accepts a complete, lint-clean manifest', () => {
    const r = validateManifest(validManifest());
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.name).toBe('@projexlight/sdk-example');
      expect(r.value.schema_version).toBe('1.0');
    }
  });
});

describe('validateManifest — structural failures', () => {
  it('rejects non-object input', () => {
    const r = validateManifest('not an object');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors[0]).toMatch(/JSON object/);
  });

  it('rejects missing schema_version', () => {
    const m = validManifest();
    delete (m as Record<string, unknown>).schema_version;
    const r = validateManifest(m);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.some((e) => e.includes('schema_version'))).toBe(true);
  });

  it('rejects unsupported schema_version', () => {
    const r = validateManifest(validManifest({ schema_version: '2.0' as never }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.some((e) => e.includes('not supported'))).toBe(true);
  });

  it('rejects pool_placement outside the enum', () => {
    const r = validateManifest(validManifest({ pool_placement: 'badzone' as never }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.some((e) => e.includes('pool_placement'))).toBe(true);
  });

  it('rejects event with bad retention_class', () => {
    const m = validManifest();
    m.provides.events[0].retention_class = 'forever' as never;
    const r = validateManifest(m);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.some((e) => e.includes('retention_class'))).toBe(true);
  });

  it('rejects event with bad conflict_policy', () => {
    const m = validManifest();
    m.provides.events[0].conflict_policy = 'magic' as never;
    const r = validateManifest(m);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.some((e) => e.includes('conflict_policy'))).toBe(true);
  });

  it('rejects pricing_sku with bad mode', () => {
    const m = validManifest();
    m.pricing_skus[0].mode = 'auction' as never;
    const r = validateManifest(m);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.some((e) => e.includes('pricing_skus'))).toBe(true);
  });

  it('rejects duplicate scenario ids', () => {
    const m = validManifest();
    m.scenarios[1].id = m.scenarios[0].id;
    const r = validateManifest(m);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.some((e) => e.includes('duplicated'))).toBe(true);
  });

  it('rejects endpoint with bad HTTP method', () => {
    const m = validManifest();
    m.provides.endpoints[0].method = 'TRACE' as never;
    const r = validateManifest(m);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.some((e) => e.includes('method'))).toBe(true);
  });
});

describe('validateManifest — lint failures', () => {
  it('rejects summary shorter than 50 chars', () => {
    const r = validateManifest(validManifest({ summary: 'too short' }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.some((e) => e.includes('summary is too short'))).toBe(true);
  });

  it('rejects summary containing TBD placeholder', () => {
    const m = validManifest({
      summary: 'TBD: write me later. This is at least fifty chars long though, OK?',
    });
    const r = validateManifest(m);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.some((e) => e.includes('placeholder "TBD"'))).toBe(true);
  });

  it('rejects fewer than 3 scenarios', () => {
    const m = validManifest();
    m.scenarios = m.scenarios.slice(0, 2);
    const r = validateManifest(m);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.some((e) => e.includes('at least 3 scenarios'))).toBe(true);
  });

  it('rejects scenario with TBD in example_code', () => {
    const m = validManifest();
    m.scenarios[0].example_code = 'TBD — implement me later';
    const r = validateManifest(m);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.some((e) => e.includes('placeholder "TBD"'))).toBe(true);
  });

  it('rejects scenario with example_code shorter than 20 chars', () => {
    const m = validManifest();
    m.scenarios[0].example_code = 'short();';
    const r = validateManifest(m);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.some((e) => e.includes('example_code is too short'))).toBe(true);
  });

  it('rejects empty compliance_posture.regimes', () => {
    const r = validateManifest(
      validManifest({ compliance_posture: { regimes: [], notes: 'none' } }),
    );
    expect(r.ok).toBe(false);
    if (!r.ok)
      expect(r.errors.some((e) => e.includes('regimes must list at least one'))).toBe(true);
  });

  it('rejects empty endpoints when no_endpoints flag is not set', () => {
    const m = validManifest();
    m.provides.endpoints = [];
    const r = validateManifest(m);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.some((e) => e.includes('endpoints is empty'))).toBe(true);
  });

  it('accepts empty endpoints when no_endpoints=true', () => {
    const m = validManifest();
    m.provides.endpoints = [];
    (m as Record<string, unknown>).no_endpoints = true;
    const r = validateManifest(m);
    expect(r.ok).toBe(true);
  });
});
