import type { ExtractionFieldSpec } from './backends';

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

const BUILTIN_SCHEMAS: Record<string, ExtractionFieldSpec[]> = {
  invoice: [
    { name: 'invoice_number', type: 'string', required: true },
    { name: 'amount', type: 'currency', required: true },
    { name: 'due_date', type: 'date', required: false },
  ],
  prescription: [
    { name: 'patient_name', type: 'string', required: true },
    { name: 'medication', type: 'string', required: true },
    { name: 'dosage', type: 'string', required: true },
  ],
  contract: [
    { name: 'invoice_number', type: 'string', required: false },
  ],
  'lab-result': [
    { name: 'patient_name', type: 'string', required: true },
  ],
};

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
