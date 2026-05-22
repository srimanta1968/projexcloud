/**
 * AC-12 proof: codegen scans @meter() decorated methods and emits a
 * registration file that the platform billing inventory consumes.
 */
import path from 'path';
import { describe, expect, it } from 'vitest';
import { scanPackage } from '../src';

describe('AC-12 · meter-codegen scans @meter decorators', () => {
  it('finds both decorated methods in the fixture', () => {
    const entries = scanPackage(path.join(__dirname));
    const skus = entries.map((e) => e.sku).sort();
    expect(skus).toContain('vault.encrypt');
    expect(skus).toContain('vault.decrypt');
    const enc = entries.find((e) => e.sku === 'vault.encrypt');
    expect(enc?.qualifiedName).toBe('VaultRoutes.encrypt');
    expect(enc?.unit).toBe('call');
    expect(enc?.tier).toBe('core');
  });
});
