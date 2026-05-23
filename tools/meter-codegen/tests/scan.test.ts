/**
 * AC-12 proof: codegen scans @meter() decorated methods and emits a
 * registration file that the platform billing inventory consumes.
 */
import path from 'path';
import { describe, expect, it } from 'vitest';
import { scanPackage, type MeterDecoratorEntry } from '../src';

describe('AC-12 · meter-codegen scans @meter decorators', () => {
  it('finds both decorated methods in the fixture', (): void => {
    const entries: MeterDecoratorEntry[] = scanPackage(path.join(__dirname));
    const skus: string[] = entries.map((e: MeterDecoratorEntry): string => e.sku).sort();
    expect(skus).toContain('vault.encrypt');
    expect(skus).toContain('vault.decrypt');
    const enc: MeterDecoratorEntry | undefined = entries.find((e: MeterDecoratorEntry): boolean => e.sku === 'vault.encrypt');
    expect(enc?.qualifiedName).toBe('VaultRoutes.encrypt');
    expect(enc?.unit).toBe('call');
    expect(enc?.tier).toBe('core');
  });
});
