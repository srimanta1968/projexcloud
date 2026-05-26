/**
 * @projexlight/blueprints — P9 / E4
 *
 * Phase 1: schema + loader + first pilot (revops-crm).
 * Phase 2: installer with clarifying-question runner + Handlebars template
 * resolution + smoke-test orchestration. Phase 2 will live in the CLI
 * (`projex blueprint apply`) and consume this package's loader.
 */

export * from './types';
export { validateBlueprint, type ValidationResult } from './validator';
export { loadBlueprint, listBlueprints, type LoadOptions } from './loader';
