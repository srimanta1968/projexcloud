/**
 * P9 / E4 — validateBlueprint.
 *
 * Hand-rolled (zero runtime deps beyond `yaml`). Schema-level checks
 * first; semantic checks (SDK refs resolve in the catalog, templates
 * exist on disk) happen at install time, not load time.
 */

import {
  Blueprint,
  ClarifyingQuestionType,
  Pack,
  SchemaVersion,
} from './types';

const SUPPORTED_SCHEMA_VERSIONS: SchemaVersion[] = ['1.0'];
const PACKS: Pack[] = ['general', 'healthcare', 'finserv', 'public-sector'];
const Q_TYPES: ClarifyingQuestionType[] = ['enum', 'string', 'boolean', 'number'];
const BLUEPRINT_ID_RE = /^[a-z][a-z0-9-]*$/;
const QUESTION_ID_RE = /^[a-z][a-z0-9_-]*$/;
const SUMMARY_MAX = 500;

export type ValidationResult =
  | { ok: true; value: Blueprint }
  | { ok: false; errors: string[] };

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === 'string');
}

export function validateBlueprint(input: unknown): ValidationResult {
  const errors: string[] = [];

  if (!isObject(input)) return { ok: false, errors: ['blueprint must be a JSON/YAML object'] };
  const b = input as Record<string, unknown>;

  // id (blueprint id: kebab-case)
  if (typeof b.id !== 'string') errors.push('id is required (string)');
  else if (!BLUEPRINT_ID_RE.test(b.id)) errors.push(`id "${b.id}" must match /^[a-z][a-z0-9-]*$/`);

  // schema_version
  if (typeof b.schema_version !== 'string') {
    errors.push('schema_version is required');
  } else if (!SUPPORTED_SCHEMA_VERSIONS.includes(b.schema_version as SchemaVersion)) {
    errors.push(
      `schema_version "${b.schema_version}" is not supported; expected one of ${SUPPORTED_SCHEMA_VERSIONS.join(', ')}`,
    );
  }

  // title
  if (typeof b.title !== 'string' || b.title.length === 0) errors.push('title is required (non-empty string)');

  // summary
  if (typeof b.summary !== 'string') errors.push('summary is required (string)');
  else if (b.summary.length > SUMMARY_MAX) errors.push(`summary is too long (${b.summary.length} chars; max ${SUMMARY_MAX})`);

  // pack
  if (typeof b.pack !== 'string') errors.push('pack is required');
  else if (!PACKS.includes(b.pack as Pack)) errors.push(`pack "${b.pack}" must be one of ${PACKS.join(', ')}`);

  // sdks
  if (!Array.isArray(b.sdks)) {
    errors.push('sdks is required (array)');
  } else if (b.sdks.length === 0) {
    errors.push('sdks must be non-empty (a blueprint with zero SDKs is just a project skeleton — use projex init instead)');
  } else {
    for (const [i, s] of b.sdks.entries()) {
      if (!isObject(s)) {
        errors.push(`sdks[${i}] must be an object`);
        continue;
      }
      const sk = s as Record<string, unknown>;
      if (typeof sk.name !== 'string') errors.push(`sdks[${i}].name is required (string)`);
      else if (!sk.name.startsWith('@projexlight/')) {
        errors.push(`sdks[${i}].name "${sk.name}" must start with @projexlight/`);
      }
      if (sk.version !== undefined && typeof sk.version !== 'string') {
        errors.push(`sdks[${i}].version must be a string when present`);
      }
    }
  }

  // clarifying_questions
  if (b.clarifying_questions !== undefined && !Array.isArray(b.clarifying_questions)) {
    errors.push('clarifying_questions must be an array when present');
  } else if (Array.isArray(b.clarifying_questions)) {
    const seenIds = new Set<string>();
    for (const [i, q] of b.clarifying_questions.entries()) {
      if (!isObject(q)) {
        errors.push(`clarifying_questions[${i}] must be an object`);
        continue;
      }
      const qq = q as Record<string, unknown>;
      if (typeof qq.id !== 'string' || !QUESTION_ID_RE.test(qq.id)) {
        errors.push(`clarifying_questions[${i}].id missing or invalid; expected /^[a-z][a-z0-9_-]*$/`);
      } else {
        if (seenIds.has(qq.id)) errors.push(`clarifying_questions[${i}].id "${qq.id}" is duplicated`);
        seenIds.add(qq.id);
      }
      if (typeof qq.prompt !== 'string') errors.push(`clarifying_questions[${i}].prompt is required (string)`);
      if (!Q_TYPES.includes(qq.type as ClarifyingQuestionType)) {
        errors.push(`clarifying_questions[${i}].type must be one of ${Q_TYPES.join(', ')}`);
      }
      if (qq.type === 'enum' && !isStringArray(qq.options)) {
        errors.push(`clarifying_questions[${i}].options is required for type=enum (string[])`);
      }
    }
  }

  // outputs
  if (!Array.isArray(b.outputs)) {
    errors.push('outputs is required (array)');
  } else {
    for (const [i, o] of b.outputs.entries()) {
      if (!isObject(o)) {
        errors.push(`outputs[${i}] must be an object`);
        continue;
      }
      const oo = o as Record<string, unknown>;
      if (typeof oo.path !== 'string') errors.push(`outputs[${i}].path is required`);
      if (typeof oo.template !== 'string') errors.push(`outputs[${i}].template is required`);
    }
  }

  // estimated_minutes
  if (typeof b.estimated_minutes !== 'number' || b.estimated_minutes <= 0) {
    errors.push('estimated_minutes is required (positive number)');
  }

  // tags optional
  if (b.tags !== undefined && !isStringArray(b.tags)) errors.push('tags must be string[] when present');

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, value: input as unknown as Blueprint };
}
