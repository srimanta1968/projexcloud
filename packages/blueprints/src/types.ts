/**
 * @projexlight/blueprints — P9 / E4 types.
 *
 * A Blueprint is a declarative composition of ProjexCloud SDKs that
 * scaffolds a runnable vertical app. The schema is intentionally narrow
 * for Phase 1: SDK list + clarifying questions + file outputs.
 *
 * Source spec: docs/v3.1/prd/P9-SDK-Discoverability-AI-Builder.md §5.4
 * (FR-BP-1, FR-BP-2).
 */

export type SchemaVersion = '1.0';

export type Pack = 'general' | 'healthcare' | 'finserv' | 'public-sector';

export type ClarifyingQuestionType = 'enum' | 'string' | 'boolean' | 'number';

export interface ClarifyingQuestion {
  /** Variable name the answer binds to (used in templates). */
  id: string;
  /** Human-readable question shown to the user. */
  prompt: string;
  type: ClarifyingQuestionType;
  /** Required for type='enum'. Allowed values. */
  options?: string[];
  /** Default value when the user accepts without answering. */
  default?: string | number | boolean;
  /** Help text rendered under the prompt. */
  help?: string;
}

export interface BlueprintSdkRef {
  /** Fully-qualified SDK name, e.g. @projexlight/sdk-vault. */
  name: string;
  /** npm-semver range; defaults to ^<latest> when omitted. */
  version?: string;
  /** Optional reason this SDK is included; surfaces in install confirmation. */
  reason?: string;
}

export interface BlueprintOutput {
  /** Path relative to the new app root. */
  path: string;
  /** Path (relative to the blueprint dir) of the Handlebars-style template. */
  template: string;
}

export interface Blueprint {
  /** Stable id used by `projex blueprint apply <id>`. */
  id: string;
  schema_version: SchemaVersion;
  title: string;
  /** One-paragraph summary; ≤500 chars. */
  summary: string;
  /** Compliance pack. Determines available tenants + guardrails. */
  pack: Pack;
  /** SDKs the blueprint composes (resolved against the local registry). */
  sdks: BlueprintSdkRef[];
  /** Optional clarifying questions the installer asks before scaffolding. */
  clarifying_questions: ClarifyingQuestion[];
  /** Template outputs the installer writes. */
  outputs: BlueprintOutput[];
  /** Operator-friendly estimate of end-to-end install time. */
  estimated_minutes: number;
  /** Free-form tags for discovery. */
  tags?: string[];
}

export interface BlueprintRecord {
  /** Absolute path to the directory containing blueprint.yaml. */
  dir: string;
  blueprint: Blueprint;
}
