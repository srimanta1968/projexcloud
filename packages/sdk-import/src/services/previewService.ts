import {
  type ColumnPreview,
  type ColumnType,
  type SchemaPreview,
  type SensitivityClass,
} from '../models/import.model';

/**
 * sdk-import schema preview (P16 · EP-375 · PCF-02-2).
 *
 * Answers "what did the importer actually give us?" before anything is mapped:
 * delimiter, encoding, whether row 1 is a header, each column's type, and — the
 * part that matters for governance — which columns hold data that must be
 * tokenized at trusted ingress, and which hold the SOURCE SYSTEM's own identifier.
 *
 * Two deliberate limits:
 *
 *   1. The preview is STRUCTURAL, never semantic. It reports "this column parses
 *      as a phone number", never "this is the contact's mobile". Naming the
 *      meaning is the importer's job, and a preview that guessed meaning would be
 *      taken as fact.
 *   2. A sensitive column's sample values are REDACTED in the output. The preview
 *      is shown in a UI, logged, and often pasted into a ticket; putting raw
 *      identifiers in it would leak them everywhere the preview travels.
 */

const DELIMITER_CANDIDATES: Array<{ char: string; label: string }> = [
  { char: ',', label: 'comma' },
  { char: '\t', label: 'tab' },
  { char: ';', label: 'semicolon' },
  { char: '|', label: 'pipe' },
];

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
// Deliberately loose: 7–15 digits with common punctuation. Strict E.164 belongs in
// the transform step, which preserves the raw value; rejecting here would flag a
// perfectly good column as untyped.
const PHONE_RE = /^\+?[\d][\d\s().-]{5,20}$/;
const URL_RE = /^https?:\/\/\S+$/i;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const INTEGER_RE = /^-?\d+$/;
const DECIMAL_RE = /^-?\d*\.\d+$/;
const BOOLEAN_RE = /^(true|false|yes|no|y|n|0|1)$/i;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const DATETIME_RE = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/;
const POSTAL_RE = /^[A-Z0-9][A-Z0-9\s-]{2,9}$/i;
const COUNTRY_RE = /^[A-Z]{2,3}$/;

/**
 * Column-name signals for sensitivity. Data-protection categories, not domain
 * vocabulary — the same list serves any vertical, which is the point.
 */
const SENSITIVITY_HINTS: Array<{ re: RegExp; klass: SensitivityClass }> = [
  { re: /(national_?id|ssn|sin|nino|passport|tax_?id|vat)/i, klass: 'government_id' },
  { re: /(iban|account_?number|card_?number|routing|sort_?code)/i, klass: 'financial' },
  { re: /(e?mail|phone|mobile|tel|whatsapp|handle)/i, klass: 'contact_point' },
  { re: /(address|street|postal|zip|post_?code|city|locality|region|geo|lat|lon)/i, klass: 'location' },
  { re: /(first_?name|last_?name|given_?name|family_?name|full_?name|dob|date_?of_?birth|birth)/i, klass: 'direct_identifier' },
];

/**
 * Column-name signals for "this is the source system's own id".
 *
 * Deliberately names no specific product or vertical. An earlier revision matched
 * a named business-system id here; the neutrality gate caught it, and rightly —
 * every such name a platform SDK carries is one more vertical it looks written
 * for. The generic forms cover the same columns without picking a side.
 */
const SOURCE_ID_RE =
  /(^|_)(external_?id|source_?id|record_?id|legacy_?id|system_?id|vendor_?id|partner_?id|ref(erence)?_?(id|no|number)?)($|_)/i;

export interface PreviewInput {
  /** Raw delimited text. Mutually exclusive with `rows`. */
  content?: string;
  /** Already-parsed rows, for a source that is not delimited text. */
  rows?: Array<Record<string, unknown>>;
  /** Override detection when the caller already knows. */
  delimiter?: string;
  has_header_row?: boolean;
  encoding?: string;
  /** How many rows to inspect. Clamped 1..1000. */
  sample_size?: number;
}

/** Redaction marker for sample values of a sensitive column. */
const REDACTED = '[redacted]';

function clampSample(n: number | undefined): number {
  return Math.min(Math.max(n ?? 200, 1), 1000);
}

/**
 * Encoding sniff. Only what can be established from the bytes we were handed: a
 * BOM, or the absence of the replacement character. Claiming more (charset
 * guessing by frequency analysis) would be a guess dressed as a fact.
 */
function detectEncoding(content: string, override?: string): { encoding: string; warning?: string } {
  if (override) return { encoding: override };
  if (content.charCodeAt(0) === 0xfeff) return { encoding: 'utf-8-bom' };
  if (content.includes('�')) {
    return {
      encoding: 'unknown',
      warning:
        'the content contains U+FFFD replacement characters — it was probably decoded with the wrong charset upstream; re-upload as UTF-8',
    };
  }
  return { encoding: 'utf-8' };
}

/**
 * Delimiter detection by CONSISTENCY, not by count. The winner is the candidate
 * that splits every sampled line into the same number of fields; a comma that
 * appears 40 times in one line and twice in the next is prose, not structure.
 */
function detectDelimiter(
  lines: string[],
  override?: string,
): { delimiter: string; confidence: number } {
  if (override) return { delimiter: override, confidence: 1 };
  let best = { delimiter: ',', confidence: 0 };
  for (const cand of DELIMITER_CANDIDATES) {
    const counts = lines.map((l) => splitLine(l, cand.char).length);
    if (counts.length === 0 || counts[0] < 2) continue;
    const first = counts[0];
    const consistent = counts.filter((c) => c === first).length;
    // Consistency across lines, nudged by field count so a 12-column comma file
    // beats a 2-column semicolon coincidence.
    const confidence = (consistent / counts.length) * Math.min(1, 0.5 + first / 20);
    if (confidence > best.confidence) best = { delimiter: cand.char, confidence };
  }
  return best;
}

/** Minimal RFC4180-aware split: honours double-quoted fields containing the delimiter. */
export function splitLine(line: string, delimiter: string): string[] {
  const out: string[] = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }
    if (ch === delimiter && !inQuotes) {
      out.push(cur);
      cur = '';
      continue;
    }
    cur += ch;
  }
  out.push(cur);
  return out.map((f) => f.trim());
}

/**
 * Header detection: row 1 is a header when its cells are short, non-numeric,
 * distinct, and look unlike the rows beneath them. Files without headers are
 * common enough that assuming one would silently eat a data row.
 */
function detectHeaderRow(
  rows: string[][],
  override?: boolean,
): { has_header_row: boolean; confidence: number } {
  if (override !== undefined) return { has_header_row: override, confidence: 1 };
  if (rows.length === 0) return { has_header_row: false, confidence: 0 };
  const first = rows[0];
  const rest = rows.slice(1);
  let score = 0;
  const distinct = new Set(first.map((c) => c.toLowerCase())).size === first.length;
  if (distinct) score += 0.3;
  if (first.every((c) => c.length > 0 && c.length <= 64)) score += 0.2;
  if (first.every((c) => !INTEGER_RE.test(c) && !DECIMAL_RE.test(c))) score += 0.3;
  // A header looks unlike its data: if the rows below are typed and row 1 is not,
  // that difference is the strongest single signal.
  if (rest.length > 0) {
    const belowTyped = rest.some((r) => r.some((c) => INTEGER_RE.test(c) || EMAIL_RE.test(c)));
    const firstTyped = first.some((c) => INTEGER_RE.test(c) || EMAIL_RE.test(c));
    if (belowTyped && !firstTyped) score += 0.2;
  }
  return { has_header_row: score >= 0.6, confidence: Number(score.toFixed(2)) };
}

function classifyValue(v: string): ColumnType {
  if (v === '') return 'empty';
  if (EMAIL_RE.test(v)) return 'email';
  if (UUID_RE.test(v)) return 'uuid';
  if (URL_RE.test(v)) return 'url';
  if (DATETIME_RE.test(v)) return 'datetime';
  if (DATE_RE.test(v)) return 'date';
  if (INTEGER_RE.test(v)) return 'integer';
  if (DECIMAL_RE.test(v)) return 'decimal';
  if (BOOLEAN_RE.test(v)) return 'boolean';
  if (PHONE_RE.test(v) && (v.match(/\d/g) ?? []).length >= 7) return 'phone';
  if (COUNTRY_RE.test(v)) return 'country';
  return 'string';
}

function detectColumnType(values: string[]): { type: ColumnType; confidence: number } {
  const present = values.filter((v) => v !== '');
  if (present.length === 0) return { type: 'empty', confidence: 1 };
  const tally = new Map<ColumnType, number>();
  for (const v of present) {
    const t = classifyValue(v);
    tally.set(t, (tally.get(t) ?? 0) + 1);
  }
  let winner: ColumnType = 'string';
  let count = 0;
  for (const [t, c] of tally) {
    if (c > count) {
      winner = t;
      count = c;
    }
  }
  const ratio = count / present.length;
  // A column that is 60% integers and 40% text is MIXED. Calling it integer would
  // send the other 40% to the exception file for no reason.
  if (ratio < 0.8 && tally.size > 1) {
    return { type: 'mixed', confidence: Number(ratio.toFixed(2)) };
  }
  return { type: winner, confidence: Number(ratio.toFixed(2)) };
}

function classifySensitivity(name: string, type: ColumnType): SensitivityClass {
  for (const hint of SENSITIVITY_HINTS) {
    if (hint.re.test(name)) return hint.klass;
  }
  // The values betray the column even when its name does not.
  if (type === 'email' || type === 'phone') return 'contact_point';
  if (type === 'postal_code') return 'location';
  return 'none';
}

/**
 * Build the preview. Pure — no database, no network, no writes — so it can run on
 * an upload before a run exists, and so it is trivially testable.
 */
export function buildPreview(input: PreviewInput): SchemaPreview {
  const warnings: string[] = [];
  const sampleSize = clampSample(input.sample_size);

  let header: string[];
  let dataRows: string[][];
  let delimiter = input.delimiter ?? ',';
  let delimiterConfidence = input.delimiter ? 1 : 0;
  let encoding = input.encoding ?? 'utf-8';
  let hasHeader = input.has_header_row ?? true;
  let headerConfidence = input.has_header_row === undefined ? 0 : 1;

  if (input.rows && input.rows.length > 0) {
    // Pre-parsed source: structure is already known, so only typing and
    // sensitivity remain.
    header = Object.keys(input.rows[0]);
    dataRows = input.rows
      .slice(0, sampleSize)
      .map((r) => header.map((h) => (r[h] === null || r[h] === undefined ? '' : String(r[h]).trim())));
    delimiter = input.delimiter ?? 'n/a';
    delimiterConfidence = 1;
    hasHeader = true;
    headerConfidence = 1;
  } else {
    const content = input.content ?? '';
    const enc = detectEncoding(content, input.encoding);
    encoding = enc.encoding;
    if (enc.warning) warnings.push(enc.warning);

    const lines = content
      .replace(/^﻿/, '')
      .split(/\r?\n/)
      .filter((l) => l.trim().length > 0)
      .slice(0, sampleSize + 1);

    if (lines.length === 0) {
      return {
        delimiter,
        delimiter_confidence: 0,
        encoding,
        has_header_row: false,
        header_confidence: 0,
        row_count: 0,
        columns: [],
        warnings: [...warnings, 'the source contained no non-empty lines'],
        previewed_at: new Date().toISOString(),
      };
    }

    const det = detectDelimiter(lines, input.delimiter);
    delimiter = det.delimiter;
    delimiterConfidence = Number(det.confidence.toFixed(2));
    if (delimiterConfidence < 0.7) {
      warnings.push(
        `delimiter detection is only ${Math.round(delimiterConfidence * 100)}% confident ('${delimiter}') — confirm it before mapping`,
      );
    }

    const allRows = lines.map((l) => splitLine(l, delimiter));
    const hdr = detectHeaderRow(allRows, input.has_header_row);
    hasHeader = hdr.has_header_row;
    headerConfidence = hdr.confidence;
    if (!hasHeader) {
      warnings.push(
        'no header row detected — columns are named by position (column_1, column_2, ...); confirm before mapping',
      );
    }

    header = hasHeader
      ? allRows[0].map((h, i) => (h.length > 0 ? h : `column_${i + 1}`))
      : allRows[0].map((_, i) => `column_${i + 1}`);
    dataRows = (hasHeader ? allRows.slice(1) : allRows).slice(0, sampleSize);

    const ragged = dataRows.filter((r) => r.length !== header.length).length;
    if (ragged > 0) {
      warnings.push(
        `${ragged} of ${dataRows.length} sampled rows have a different field count than the header — those rows will land in the exception file`,
      );
    }
  }

  const columns: ColumnPreview[] = header.map((name, index) => {
    const values = dataRows.map((r) => r[index] ?? '');
    const { type, confidence } = detectColumnType(values);
    const sensitivity = classifySensitivity(name, type);
    const isSourceId =
      SOURCE_ID_RE.test(name) ||
      // An all-distinct, fully-populated uuid column is an identifier even when
      // nobody named it one.
      (type === 'uuid' && new Set(values.filter(Boolean)).size === values.filter(Boolean).length);
    const sensitive = sensitivity !== 'none';
    return {
      name,
      index,
      detected_type: type,
      type_confidence: confidence,
      sensitivity,
      // Every sensitive class is tokenized at trusted ingress. The classification
      // decides WHICH vault policy applies; it never decides whether to protect.
      tokenize_at_ingress: sensitive,
      is_source_id: isSourceId,
      null_count: values.filter((v) => v === '').length,
      distinct_count: new Set(values.filter((v) => v !== '')).size,
      sample_values: sensitive
        ? values.filter(Boolean).slice(0, 3).map(() => REDACTED)
        : values.filter(Boolean).slice(0, 3),
    };
  });

  const sourceIdColumns = columns.filter((c) => c.is_source_id);
  if (sourceIdColumns.length > 0) {
    warnings.push(
      `source identifier column(s) detected (${sourceIdColumns.map((c) => c.name).join(', ')}) — these are preserved as crosswalks and are never replaced by platform ids`,
    );
  }

  return {
    delimiter,
    delimiter_confidence: delimiterConfidence,
    encoding,
    has_header_row: hasHeader,
    header_confidence: headerConfidence,
    row_count: dataRows.length,
    columns,
    warnings,
    previewed_at: new Date().toISOString(),
  };
}
