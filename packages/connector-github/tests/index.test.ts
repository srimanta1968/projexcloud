import { describe, it, expect } from 'vitest';
import * as pkg from '../src/index';

describe('packages/connector-github public surface', () => {
  it('imports cleanly and exports at least one named symbol', () => {
    const keys = Object.keys(pkg);
    expect(keys.length).toBeGreaterThan(0);
  });
});
