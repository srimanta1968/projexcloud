/**
 * @projexlight/sdk-capability — P9 / E1
 *
 * Defines and validates the sdk-capability.json manifest every SDK ships.
 * See docs/v3.1/prd/P9-SDK-Discoverability-AI-Builder.md §5.1.
 *
 * Public surface:
 *   - SdkCapabilityManifest + sub-types
 *   - validateManifest(input) → { ok, value | errors }
 *   - diffManifests(a, b) → ManifestDiff
 *
 * The scaffold CLI is exported as a bin entry; consume via `npx
 * @projexlight/sdk-capability scaffold` (see src/cli.ts).
 */

export * from './types';
export { validateManifest, diffManifests, type ValidationResult } from './validator';
export { runLints } from './lint';
