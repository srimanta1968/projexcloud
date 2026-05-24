/**
 * @projexlight/sdk-taxonomy — public surface.
 *
 * P6A. Versioned artifact taxonomies, extraction schemas, prompt templates,
 * per-tenant overrides, version migration plans. v0 surface (scaffold):
 * migrationsDir only; lookup endpoints + version activation land in TK-3292.
 */
export { migrationsDir } from './db';
export * as server from './server';

// Lookup + activation (PRD §5.2 taxonomy) — TK-3292.
export {
  lookupExtractionSchema,
  lookupPromptTemplate,
  activateTaxonomyVersion,
} from './services/taxonomyService';
export type { ActivateVersionResult } from './services/taxonomyService';
