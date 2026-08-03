import VOCABULARY from './document-vocabulary.json';

/**
 * Pluggable backends for sdk-parsing.
 *
 * Production swaps these via setters. Defaults are lightweight enough
 * to run an end-to-end 8-stage pipeline against a synthetic document
 * in CI without any external dependencies — the AC-1 integration test
 * uses these defaults plus a Postgres test database.
 *
 * Real backends:
 *   - OcrBackend       → Tesseract (open-source) · AWS Textract · Google Document AI
 *   - ClassifierBackend → sdk-ai-gateway with task_tag='document-classify'
 *   - ExtractorBackend  → sdk-ai-gateway with the resolved extraction schema
 *   - ValidatorBackend  → schema-driven validation (Ajv) + provider-of-truth checks
 */

export interface OcrInput {
  source_blob_id: string;
  tenant_id: string;
}
export interface OcrOutput {
  pages: Array<{ page: number; text: string }>;
  language?: string;
}
export interface OcrBackend {
  ocr(input: OcrInput): Promise<OcrOutput>;
}

export interface ClassifierInput {
  text: string;
  hints?: { document_kind?: string };
}
export interface ClassifierOutput {
  document_kind: string;
  confidence: number;
}
export interface ClassifierBackend {
  classify(input: ClassifierInput): Promise<ClassifierOutput>;
}

export interface ExtractionFieldSpec {
  name: string;
  /** JSON-schema-like type for validator. */
  type?: 'string' | 'number' | 'boolean' | 'date' | 'currency';
  /** When set, validator requires the value to be present. */
  required?: boolean;
}

export interface ExtractorInput {
  text: string;
  field_specs: ExtractionFieldSpec[];
  tenant_id: string;
}
export interface ExtractedFieldValue {
  field_name: string;
  value: string | number | boolean | null;
  confidence: number;
  provenance_span?: {
    page?: number;
    char_start?: number;
    char_end?: number;
    bbox?: [number, number, number, number];
  };
}
export interface ExtractorBackend {
  extract(input: ExtractorInput): Promise<{ fields: ExtractedFieldValue[] }>;
}

export interface ValidatorInput {
  fields: ExtractedFieldValue[];
  field_specs: ExtractionFieldSpec[];
}
export interface ValidatorOutput {
  /** Per-field validation status; mirrors fields by order. */
  results: Array<{ field_name: string; ok: boolean; reason?: string }>;
}
export interface ValidatorBackend {
  validate(input: ValidatorInput): Promise<ValidatorOutput>;
}

/* ============================================================
 * Defaults — synthesised, deterministic, dependency-free.
 * ============================================================ */

/**
 * v1 OCR stub: pretends the blob already contains plaintext keyed by
 * source_blob_id in a process-local map. Tests seed via
 * `LocalOcrBackend.seed(blob_id, text)`. Production swaps via
 * setOcrBackend(new TesseractBackend(...)).
 */
export class LocalOcrBackend implements OcrBackend {
  private readonly store = new Map<string, OcrOutput>();

  seed(blob_id: string, text: string, language = 'en'): void {
    this.store.set(blob_id, {
      pages: text.split(/\f|\n{3,}/).map((page, idx) => ({ page: idx + 1, text: page })),
      language,
    });
  }

  async ocr(input: OcrInput): Promise<OcrOutput> {
    const cached = this.store.get(input.source_blob_id);
    if (!cached) {
      // Defensive default — emit one empty page so the pipeline can
      // continue and the routing stage flags it as needs-review.
      return { pages: [{ page: 1, text: '' }], language: 'en' };
    }
    return cached;
  }
}

/** Keyword-based classifier. Sufficient for AC-1 fixtures. */
export class KeywordClassifierBackend implements ClassifierBackend {
  constructor(
    // Loaded from document-vocabulary.json: these keywords are vertical-specific by
    // nature, so holding them as DATA keeps this class a neutral mechanism that a tenant
    // or vertical replaces, rather than an implicitly healthcare/finance package.
    private readonly rules: Array<{ kind: string; keywords: string[] }> = VOCABULARY.classifier_rules,
  ) {}

  async classify(input: ClassifierInput): Promise<ClassifierOutput> {
    if (input.hints?.document_kind) {
      return { document_kind: input.hints.document_kind, confidence: 1.0 };
    }
    const lc = input.text.toLowerCase();
    let best = { kind: 'unknown', score: 0 };
    for (const rule of this.rules) {
      const hits = rule.keywords.filter((k) => lc.includes(k)).length;
      if (hits > best.score) best = { kind: rule.kind, score: hits };
    }
    const confidence = best.score === 0 ? 0.2 : Math.min(0.5 + best.score * 0.15, 0.99);
    return { document_kind: best.kind, confidence };
  }
}

/**
 * Regex-driven extractor. Each field_spec.name maps to a coarse regex.
 * Confidence falls when the spec doesn't have a known pattern (caller
 * can route to needs-review). Production replaces with sdk-ai-gateway
 * + the resolved taxonomy.extraction_schema.
 */
export class RegexExtractorBackend implements ExtractorBackend {
  // Compiled from document-vocabulary.json for the same reason as the classifier
  // rules above — the mechanism is neutral, the vocabulary is replaceable data.
  private readonly patterns: Record<string, RegExp> = Object.fromEntries(
    Object.entries(VOCABULARY.extraction_patterns).map(([k, v]) => [k, new RegExp(v as string, 'i')]),
  );

  async extract(input: ExtractorInput): Promise<{ fields: ExtractedFieldValue[] }> {
    const out: ExtractedFieldValue[] = [];
    for (const spec of input.field_specs) {
      const pattern = this.patterns[spec.name];
      if (!pattern) {
        out.push({ field_name: spec.name, value: null, confidence: 0.0 });
        continue;
      }
      const match = input.text.match(pattern);
      if (!match) {
        out.push({ field_name: spec.name, value: null, confidence: 0.1 });
        continue;
      }
      const raw = match[1].trim();
      const value = coerceValue(raw, spec.type);
      const span_start = match.index ?? 0;
      out.push({
        field_name: spec.name,
        value,
        confidence: value === null ? 0.4 : 0.85,
        provenance_span: { char_start: span_start, char_end: span_start + match[0].length },
      });
    }
    return { fields: out };
  }
}

function coerceValue(raw: string, type?: ExtractionFieldSpec['type']): string | number | boolean | null {
  if (!type || type === 'string') return raw;
  if (type === 'number' || type === 'currency') {
    const n = Number(raw.replace(/[,$\s]/g, ''));
    return Number.isFinite(n) ? n : null;
  }
  if (type === 'date') {
    const d = new Date(raw);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }
  if (type === 'boolean') return /^(true|yes|y|1)$/i.test(raw);
  return raw;
}

/** Schema-driven validator: required fields must have non-null values
 *  above the confidence threshold (default 0.7). */
export class SchemaValidatorBackend implements ValidatorBackend {
  constructor(private readonly minConfidence: number = 0.7) {}

  async validate(input: ValidatorInput): Promise<ValidatorOutput> {
    const specByName = new Map(input.field_specs.map((s) => [s.name, s]));
    const results = input.fields.map((f) => {
      const spec = specByName.get(f.field_name);
      if (!spec) return { field_name: f.field_name, ok: true };
      if (spec.required && f.value === null) {
        return { field_name: f.field_name, ok: false, reason: 'required field missing' };
      }
      if (f.confidence < this.minConfidence) {
        return { field_name: f.field_name, ok: false, reason: `confidence ${f.confidence} below ${this.minConfidence}` };
      }
      return { field_name: f.field_name, ok: true };
    });
    return { results };
  }
}

/* ============================================================
 * Singleton registry — production callers swap via setters.
 * ============================================================ */

let _ocr: OcrBackend = new LocalOcrBackend();
let _classifier: ClassifierBackend = new KeywordClassifierBackend();
let _extractor: ExtractorBackend = new RegexExtractorBackend();
let _validator: ValidatorBackend = new SchemaValidatorBackend();

export function setOcrBackend(b: OcrBackend): void { _ocr = b; }
export function setClassifierBackend(b: ClassifierBackend): void { _classifier = b; }
export function setExtractorBackend(b: ExtractorBackend): void { _extractor = b; }
export function setValidatorBackend(b: ValidatorBackend): void { _validator = b; }

export function getOcrBackend(): OcrBackend { return _ocr; }
export function getClassifierBackend(): ClassifierBackend { return _classifier; }
export function getExtractorBackend(): ExtractorBackend { return _extractor; }
export function getValidatorBackend(): ValidatorBackend { return _validator; }

/** Test hook — restore default backends between suites. */
export function _resetParsingBackends(): void {
  _ocr = new LocalOcrBackend();
  _classifier = new KeywordClassifierBackend();
  _extractor = new RegexExtractorBackend();
  _validator = new SchemaValidatorBackend();
}
