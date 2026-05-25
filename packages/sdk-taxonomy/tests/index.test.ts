import { describe, it, expect } from 'vitest';
import * as taxonomy from '../src/index';

describe('sdk-taxonomy public surface', () => {
  it('exports the three lookup/activate functions and migrationsDir', () => {
    expect(typeof taxonomy.lookupExtractionSchema).toBe('function');
    expect(typeof taxonomy.lookupPromptTemplate).toBe('function');
    expect(typeof taxonomy.activateTaxonomyVersion).toBe('function');
    expect(typeof taxonomy.migrationsDir).toBe('string');
    expect(taxonomy.migrationsDir.length).toBeGreaterThan(0);
  });
});
