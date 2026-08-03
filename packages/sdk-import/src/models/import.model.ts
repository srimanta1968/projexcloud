/**
 * sdk-import domain model (P16 · EP-375).
 *
 * The TypeScript unions mirror the Postgres ENUM types from migration 001
 * one-for-one, so an unrecognised value is a compile error on the way in and a
 * write error at the database.
 */

export const IMPORT_RUN_STATUSES = [
  'draft',
  'previewing',
  'mapping',
  'dry_run',
  'committing',
  'complete',
  'quarantined',
  'rolled_back',
] as const;
export type ImportRunStatus = (typeof IMPORT_RUN_STATUSES)[number];

/**
 * The run lifecycle. Only `complete` may roll back, and `quarantined` is where a
 * run parks when it needs a human rather than a retry.
 */
export const RUN_TRANSITIONS: Record<ImportRunStatus, readonly ImportRunStatus[]> = {
  draft: ['previewing', 'quarantined'],
  previewing: ['mapping', 'quarantined'],
  mapping: ['dry_run', 'mapping', 'quarantined'],
  dry_run: ['committing', 'mapping', 'dry_run', 'quarantined'],
  committing: ['complete', 'quarantined'],
  complete: ['rolled_back'],
  quarantined: ['mapping'],
  rolled_back: [],
};

export const MAPPING_TEMPLATE_KINDS = ['certified', 'custom'] as const;
export type MappingTemplateKind = (typeof MAPPING_TEMPLATE_KINDS)[number];

export const CROSSWALK_STRATEGIES = [
  'preserve_existing',
  'add_alias',
  'reject_conflict',
] as const;
export type CrosswalkStrategy = (typeof CROSSWALK_STRATEGIES)[number];

export const LINEAGE_ACTIONS = ['created', 'linked', 'updated', 'asserted', 'reversed'] as const;
export type LineageAction = (typeof LINEAGE_ACTIONS)[number];

export interface ImportRun {
  run_id: string;
  tenant_id: string;
  source_kind: string;
  source_ref: string | null;
  file_fingerprint: string;
  file_name: string | null;
  status: ImportRunStatus;
  mapping_template_id: string | null;
  field_map: Record<string, FieldMapping>;
  transform_plan: TransformPlan | null;
  preview: SchemaPreview | null;
  dry_run_result: DryRunResult | null;
  attestation_id: string | null;
  row_count: number | null;
  committed_row_count: number | null;
  exception_count: number;
  rollback_window: string;
  rollback_deadline: string | null;
  rolled_back_at: string | null;
  rollback_reason: string | null;
  quarantine_reason: string | null;
  committed_at: string | null;
  started_by: string | null;
  correlation_id: string;
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

/* ------------------------------------------------------------- preview */

/**
 * Detected column types. Deliberately structural, not semantic: the preview says
 * "this column holds text that parses as a phone number", never "this column is
 * the mobile number of the primary contact" — that judgement is the importer's.
 */
export const COLUMN_TYPES = [
  'string',
  'integer',
  'decimal',
  'boolean',
  'date',
  'datetime',
  'email',
  'phone',
  'url',
  'uuid',
  'postal_code',
  'country',
  'empty',
  'mixed',
] as const;
export type ColumnType = (typeof COLUMN_TYPES)[number];

/**
 * Why a column is flagged sensitive. These are data-protection categories, not
 * domain vocabulary: they decide what gets tokenized at trusted ingress.
 */
export const SENSITIVITY_CLASSES = [
  'direct_identifier',
  'contact_point',
  'location',
  'government_id',
  'financial',
  'none',
] as const;
export type SensitivityClass = (typeof SENSITIVITY_CLASSES)[number];

export interface ColumnPreview {
  name: string;
  index: number;
  detected_type: ColumnType;
  /** 0..1. How consistently the sample matched the detected type. */
  type_confidence: number;
  sensitivity: SensitivityClass;
  /** True when the column must be tokenized at trusted ingress before storage. */
  tokenize_at_ingress: boolean;
  /**
   * True when the column looks like the SOURCE SYSTEM's own identifier. Those
   * become crosswalks and are never overwritten by platform ids.
   */
  is_source_id: boolean;
  null_count: number;
  distinct_count: number;
  /** Redacted samples — a flagged column never puts raw values in the preview. */
  sample_values: string[];
}

export interface SchemaPreview {
  delimiter: string;
  delimiter_confidence: number;
  encoding: string;
  has_header_row: boolean;
  header_confidence: number;
  row_count: number;
  columns: ColumnPreview[];
  warnings: string[];
  previewed_at: string;
}

/* ------------------------------------------------------------- mapping */

/**
 * The canonical targets a source column may map to. Entity-kind prefixed on
 * purpose: `place.address_line1` cannot be mistaken for a column on the person,
 * which is exactly the mistake this SDK refuses to make.
 */
export const CANONICAL_TARGETS = [
  'person.given_name',
  'person.family_name',
  'person.full_name',
  'person.date_of_birth',
  'contact.email',
  'contact.phone',
  'contact.handle',
  'org.name',
  'org.domain',
  'org.size',
  'place.address_line1',
  'place.address_line2',
  'place.locality',
  'place.region',
  'place.postal_code',
  'place.country',
  'external.id',
  'attribute.custom',
  'unmapped',
] as const;
export type CanonicalTarget = (typeof CANONICAL_TARGETS)[number];

/** Targets that describe a PLACE. A place is its own entity, never a person column. */
export const PLACE_TARGETS: readonly CanonicalTarget[] = [
  'place.address_line1',
  'place.address_line2',
  'place.locality',
  'place.region',
  'place.postal_code',
  'place.country',
];

/**
 * A proposed mapping for one source column.
 *
 * `confirmed` is the whole point: a suggestion is inert until a human sets it.
 * The commit path reads only confirmed mappings, so an unreviewed AI guess can
 * never silently land data.
 */
export interface FieldMapping {
  source_column: string;
  target: CanonicalTarget;
  /** 0..1 — how sure the proposer is. Always present, even at 0. */
  confidence: number;
  /** Human-readable justification. Always present; never empty. */
  reason: string;
  /** Who proposed it: the deterministic matcher, the AI assistant, or a person. */
  proposed_by: 'heuristic' | 'assistant' | 'human';
  /** Inert until a human confirms. */
  confirmed: boolean;
  confirmed_by?: string | null;
  confirmed_at?: string | null;
  /**
   * Present when the target belongs to a related entity rather than the subject:
   * the row's address becomes a place PLUS a relationship, not person columns.
   */
  relationship?: RelationshipHint | null;
  /** Set when the column is the source system's own id — becomes a crosswalk. */
  crosswalk?: { external_system: string } | null;
  sensitivity: SensitivityClass;
  tokenize_at_ingress: boolean;
}

export interface RelationshipHint {
  subject_kind: string;
  predicate: string;
  object_kind: string;
  reason: string;
}

export interface MappingSuggestion extends FieldMapping {
  /** Ranked alternatives, so the importer can correct without starting over. */
  alternatives: Array<{ target: CanonicalTarget; confidence: number; reason: string }>;
}

/* ----------------------------------------------------------- transform */

export interface TransformStep {
  source_column: string;
  target: CanonicalTarget;
  operation: string;
  /** What the step does, in words a reviewer can check. */
  description: string;
  /** Whether the raw input survives alongside the transformed value as evidence. */
  preserves_raw: boolean;
  /** Off unless explicitly enabled — see LIFECYCLE_MAPPING_DEFAULT. */
  enabled: boolean;
  params?: Record<string, unknown>;
}

export interface TransformPlan {
  steps: TransformStep[];
  /** Steps that need a human decision before the plan can run. */
  review_required: Array<{ source_column: string; reason: string }>;
  built_at: string;
}

/* ------------------------------------------------------------- dry run */

export interface DryRunResult {
  new_count: number;
  exact_link_count: number;
  review_case_count: number;
  related_entity_count: number;
  invalid_count: number;
  governance: GovernanceVerdict[];
  /** Proof the run wrote nothing, captured from the database itself. */
  writes_observed: number;
  notifications_dispatched: number;
  ran_at: string;
}

export interface GovernanceVerdict {
  check: string;
  passed: boolean;
  detail: string;
}
