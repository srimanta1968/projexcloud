import type { ExtractionFieldSpec } from './backends';
import VOCABULARY from './document-vocabulary.json';

/**
 * Schema resolver — given a classified document_kind, return the field
 * specs the extractor should pull. In production this composes with
 * sdk-taxonomy.lookupExtractionSchema(document_kind, taxonomy_version_id)
 * which reads from taxonomy.extraction_schema.
 *
 * v1 ships a built-in schema set keyed by the keyword-classifier kinds
 * so AC-1 fixtures + the integration test can run without seeding the
 * taxonomy schema.
 */

/*
 * Loaded from document-vocabulary.json rather than written here (P16 EP-387).
 *
 * These field sets are vertical-specific by nature — an invoice, a prescription and a lab
 * result belong to different industries. Holding them in TypeScript made sdk-parsing
 * implicitly a healthcare/finance package, so the next vertical would fork it instead of
 * configuring it. As data they are a replaceable default; sdk-taxonomy still wins whenever
 * it resolves, which is the production path.
 */
const BUILTIN_SCHEMAS: Record<string, ExtractionFieldSpec[]> =
  VOCABULARY.builtin_schemas as unknown as Record<string, ExtractionFieldSpec[]>;

export interface ResolveSchemaInput {
  document_kind: string;
  /** Optional taxonomy version pin — when unset, returns the built-in. */
  taxonomy_version_id?: string;
}

export interface ResolvedSchema {
  document_kind: string;
  taxonomy_version_id: string;
  field_specs: ExtractionFieldSpec[];
}

/**
 * Pluggable schema resolver hook so production can swap to sdk-taxonomy.
 */
let _resolver: (input: ResolveSchemaInput) => Promise<ResolvedSchema> = defaultResolveSchema;

export function setSchemaResolver(resolver: (input: ResolveSchemaInput) => Promise<ResolvedSchema>): void {
  _resolver = resolver;
}

export async function resolveSchema(input: ResolveSchemaInput): Promise<ResolvedSchema> {
  return _resolver(input);
}

async function defaultResolveSchema(input: ResolveSchemaInput): Promise<ResolvedSchema> {
  const fields = BUILTIN_SCHEMAS[input.document_kind] ?? [];
  return {
    document_kind: input.document_kind,
    taxonomy_version_id: input.taxonomy_version_id ?? 'builtin-v1',
    field_specs: fields,
  };
}

/** Test hook — restore default resolver. */
export function _resetSchemaResolver(): void {
  _resolver = defaultResolveSchema;
}
