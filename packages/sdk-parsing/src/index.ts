/**
 * @projexlight/sdk-parsing — public surface.
 *
 * P6B · 8-stage document pipeline: ingest → ocr → classify → schema-resolve
 * → extract → validate → review → route. Schema selection at runtime from
 * sdk-taxonomy. Per-field confidence + needs-review queue composed with
 * sdk-approval. Emits lineage edges per extracted field (FR-PRS-6).
 */
export { migrationsDir } from './db';

// Orchestrator (FR-PRS-1..6 / AC-1).
export { parseDocument, getJob, listJobs } from './services/parseOrchestrator';
export type { ParseDocumentInput, ParseDocumentResult } from './services/parseOrchestrator';

// Pluggable backends — production wires real OCR / classifier / extractor.
export {
  setOcrBackend,
  setClassifierBackend,
  setExtractorBackend,
  setValidatorBackend,
  getOcrBackend,
  getClassifierBackend,
  getExtractorBackend,
  getValidatorBackend,
  LocalOcrBackend,
  KeywordClassifierBackend,
  RegexExtractorBackend,
  SchemaValidatorBackend,
  _resetParsingBackends,
} from './services/backends';
export type {
  OcrBackend,
  ClassifierBackend,
  ExtractorBackend,
  ValidatorBackend,
  OcrInput,
  OcrOutput,
  ClassifierInput,
  ClassifierOutput,
  ExtractorInput,
  ExtractedFieldValue,
  ExtractionFieldSpec,
  ValidatorInput,
  ValidatorOutput,
} from './services/backends';

// Schema resolver hook (composes with sdk-taxonomy in production).
export { resolveSchema, setSchemaResolver, _resetSchemaResolver } from './services/schemaResolver';
export type { ResolveSchemaInput, ResolvedSchema } from './services/schemaResolver';
