import {
  PLACE_TARGETS,
  type CanonicalTarget,
  type ColumnPreview,
  type FieldMapping,
  type MappingSuggestion,
  type RelationshipHint,
  type SchemaPreview,
} from '../models/import.model';

/**
 * sdk-import mapping assistant (P16 · EP-375 · PCF-02-2).
 *
 * Proposes a canonical target for each source column, with a confidence and a
 * reason a human can check. Three rules make this safe:
 *
 *   1. IT PROPOSES, IT NEVER APPLIES. Every suggestion comes back
 *      `confirmed: false`. Only confirmMapping — driven by an explicit human
 *      decision per field — flips that, and only confirmed mappings are read by
 *      the commit path. An unreviewed guess cannot land data, which is the
 *      difference between an assistant and an accident.
 *   2. AN ADDRESS IS A PLACE, NOT A PERSON COLUMN. Address columns propose a
 *      `place.*` target plus a RELATIONSHIP between the subject and that place.
 *      Flattening an address onto the person is the single most common import
 *      mistake: it makes a shared address unmergeable, breaks history when
 *      someone moves, and quietly duplicates the location for every occupant.
 *   3. THE AI NEVER SEES RAW VALUES. The optional assistant hook is handed column
 *      NAMES, detected types and redacted samples only — the same redaction the
 *      preview applies. A mapping suggestion is not worth leaking identifiers to
 *      a third-party model for.
 *
 * With no AI wired, the deterministic matcher below produces the suggestions. It
 * is not a fallback stub — it is the honest baseline, and it carries the same
 * confidence-and-reason contract.
 */

interface Rule {
  re: RegExp;
  target: CanonicalTarget;
  confidence: number;
  reason: string;
}

/**
 * Deterministic column-name rules. Ordered: the first match wins, so the more
 * specific patterns come first.
 */
const RULES: Rule[] = [
  { re: /^(e?mail|e?mail_?address)$/i, target: 'contact.email', confidence: 0.95, reason: 'column name is an exact match for an email address field' },
  { re: /e?mail/i, target: 'contact.email', confidence: 0.75, reason: 'column name contains "email"' },
  { re: /^(phone|telephone|tel|mobile|cell|msisdn)(_?number)?$/i, target: 'contact.phone', confidence: 0.92, reason: 'column name is an exact match for a telephone field' },
  { re: /(phone|mobile|tel|msisdn)/i, target: 'contact.phone', confidence: 0.7, reason: 'column name contains a telephone token' },
  { re: /^(first_?name|given_?name|forename)$/i, target: 'person.given_name', confidence: 0.93, reason: 'column name is an exact match for a given name' },
  { re: /^(last_?name|family_?name|surname)$/i, target: 'person.family_name', confidence: 0.93, reason: 'column name is an exact match for a family name' },
  { re: /^(full_?name|name|display_?name|contact_?name)$/i, target: 'person.full_name', confidence: 0.7, reason: 'column name suggests a whole personal name; the transform plan will split it, leaving uncertain suffixes for review' },
  { re: /(date_?of_?birth|birth_?date|^dob$)/i, target: 'person.date_of_birth', confidence: 0.9, reason: 'column name is an exact match for a date of birth' },
  { re: /^(company|company_?name|organi[sz]ation|org_?name|account_?name|business_?name)$/i, target: 'org.name', confidence: 0.88, reason: 'column name is an exact match for an organisation name' },
  { re: /^(website|domain|web_?site|url)$/i, target: 'org.domain', confidence: 0.75, reason: 'column name suggests an organisation web domain' },
  { re: /(employee_?count|headcount|company_?size|org_?size|num_?employees)/i, target: 'org.size', confidence: 0.8, reason: 'column name suggests an organisation size measure' },
  { re: /^(address|address_?1|address_?line_?1|street|street_?address)$/i, target: 'place.address_line1', confidence: 0.9, reason: 'column name is an exact match for the first line of a street address' },
  { re: /^(address_?2|address_?line_?2|suite|unit|apt|apartment)$/i, target: 'place.address_line2', confidence: 0.85, reason: 'column name is an exact match for a secondary address line' },
  { re: /^(city|town|locality)$/i, target: 'place.locality', confidence: 0.9, reason: 'column name is an exact match for a locality' },
  { re: /^(state|province|region|county)$/i, target: 'place.region', confidence: 0.85, reason: 'column name is an exact match for an administrative region' },
  { re: /(post(al)?_?code|zip(_?code)?)/i, target: 'place.postal_code', confidence: 0.9, reason: 'column name is an exact match for a postal code' },
  { re: /^(country|country_?code|nation)$/i, target: 'place.country', confidence: 0.9, reason: 'column name is an exact match for a country' },
  { re: /(handle|username|user_?name|profile_?url|social)/i, target: 'contact.handle', confidence: 0.7, reason: 'column name suggests a labelled social or messaging handle' },
];

/** Type-based fallbacks, used when the column NAME says nothing useful. */
const TYPE_RULES: Partial<Record<string, { target: CanonicalTarget; confidence: number; reason: string }>> = {
  email: { target: 'contact.email', confidence: 0.8, reason: 'the sampled values parse as email addresses even though the column name does not say so' },
  phone: { target: 'contact.phone', confidence: 0.7, reason: 'the sampled values parse as telephone numbers even though the column name does not say so' },
};

/**
 * The relationship an address column implies. Emitted alongside every place
 * target so the commit path creates a place entity and an assertion linking the
 * subject to it — never a column on the subject.
 */
const PLACE_RELATIONSHIP: RelationshipHint = {
  subject_kind: 'person',
  predicate: 'located_at',
  object_kind: 'place',
  reason:
    'an address is a place in its own right: flattening it onto the subject makes a shared address unmergeable, loses history when the subject moves, and duplicates the location for every occupant',
};

/* ------------------------------------------------------------------ hook */

export interface AssistantRequest {
  /** Column names + detected types + REDACTED samples. Never raw values. */
  columns: Array<{
    name: string;
    detected_type: string;
    sensitivity: string;
    sample_values: string[];
  }>;
  candidate_targets: readonly CanonicalTarget[];
  tenant_id: string;
}

export interface AssistantProposal {
  source_column: string;
  target: CanonicalTarget;
  confidence: number;
  reason: string;
  alternatives?: Array<{ target: CanonicalTarget; confidence: number; reason: string }>;
}

export type MappingAssistant = (req: AssistantRequest) => Promise<AssistantProposal[]>;

let assistant: MappingAssistant | null = null;

/**
 * Wire sdk-ai-gateway (POST /api/ai-gateway/complete) at app boot. Absent by
 * design: with no assistant the deterministic matcher stands on its own, and a
 * deployment without an AI budget still gets suggestions rather than an error.
 */
export function setMappingAssistant(fn: MappingAssistant | null): void {
  assistant = fn;
}

/** Redacts before anything leaves the process, independent of preview redaction. */
function toAssistantRequest(preview: SchemaPreview, tenant_id: string): AssistantRequest {
  return {
    tenant_id,
    candidate_targets: [...PLACE_TARGETS, 'contact.email', 'contact.phone', 'contact.handle',
      'person.given_name', 'person.family_name', 'person.full_name', 'person.date_of_birth',
      'org.name', 'org.domain', 'org.size', 'external.id', 'attribute.custom', 'unmapped'],
    columns: preview.columns.map((c) => ({
      name: c.name,
      detected_type: c.detected_type,
      sensitivity: c.sensitivity,
      // Belt and braces: even though buildPreview already redacted these, the
      // outbound payload re-applies the rule rather than trusting its input.
      sample_values: c.sensitivity === 'none' ? c.sample_values.slice(0, 3) : [],
    })),
  };
}

function heuristicFor(column: ColumnPreview): {
  target: CanonicalTarget;
  confidence: number;
  reason: string;
  alternatives: Array<{ target: CanonicalTarget; confidence: number; reason: string }>;
} {
  // A source-system identifier outranks every name rule: preserving it as a
  // crosswalk is what keeps the record findable in the system it came from.
  if (column.is_source_id) {
    return {
      target: 'external.id',
      confidence: 0.9,
      reason:
        'the column holds the source system’s own identifier — it is preserved as a crosswalk and never replaced by a platform id',
      alternatives: [
        { target: 'attribute.custom', confidence: 0.2, reason: 'if this is not actually a source identifier, keep it as a custom attribute' },
      ],
    };
  }

  for (const rule of RULES) {
    if (rule.re.test(column.name)) {
      const alternatives: Array<{ target: CanonicalTarget; confidence: number; reason: string }> = [];
      const typeRule = TYPE_RULES[column.detected_type];
      if (typeRule && typeRule.target !== rule.target) {
        alternatives.push(typeRule);
      }
      alternatives.push({
        target: 'attribute.custom',
        confidence: 0.15,
        reason: 'keep the column as a custom attribute instead of mapping it to a canonical field',
      });
      return { ...rule, alternatives };
    }
  }

  const typeRule = TYPE_RULES[column.detected_type];
  if (typeRule) {
    return {
      ...typeRule,
      alternatives: [
        { target: 'attribute.custom', confidence: 0.3, reason: 'keep as a custom attribute if the value is not a contact point' },
      ],
    };
  }

  return {
    target: 'unmapped',
    confidence: 0,
    reason:
      'no canonical target matched the column name or its sampled values — confirm a target or leave it unmapped',
    alternatives: [
      { target: 'attribute.custom', confidence: 0.25, reason: 'store the column verbatim as a custom attribute' },
    ],
  };
}

/**
 * Propose a mapping for every column in the preview.
 *
 * The AI assistant, when wired, may only OVERRIDE a heuristic proposal it beats on
 * confidence, and its reason is prefixed so a reviewer always knows which
 * suggestions came from a model. Every returned suggestion has confirmed:false.
 */
export async function suggestMapping(
  preview: SchemaPreview,
  ctx: { tenant_id: string; source_system?: string },
): Promise<MappingSuggestion[]> {
  const base = new Map<string, MappingSuggestion>();

  for (const column of preview.columns) {
    const h = heuristicFor(column);
    base.set(column.name, {
      source_column: column.name,
      target: h.target,
      confidence: h.confidence,
      reason: h.reason,
      proposed_by: 'heuristic',
      confirmed: false,
      relationship: PLACE_TARGETS.includes(h.target) ? PLACE_RELATIONSHIP : null,
      // The crosswalk's external_system is the run's source, not the column name:
      // the id is meaningless without knowing which system issued it.
      crosswalk: h.target === 'external.id' ? { external_system: ctx.source_system ?? '' } : null,
      sensitivity: column.sensitivity,
      tokenize_at_ingress: column.tokenize_at_ingress,
      alternatives: h.alternatives,
    });
  }

  if (assistant) {
    try {
      const proposals = await assistant(toAssistantRequest(preview, ctx.tenant_id));
      for (const p of proposals) {
        const existing = base.get(p.source_column);
        if (!existing) continue;
        // The model has to BEAT the deterministic match, not merely disagree with
        // it. An exact column-name match is more trustworthy than a guess.
        if (p.confidence <= existing.confidence) continue;
        base.set(p.source_column, {
          ...existing,
          target: p.target,
          confidence: Math.min(Math.max(p.confidence, 0), 1),
          reason: `assistant: ${p.reason}`,
          proposed_by: 'assistant',
          confirmed: false,
          relationship: PLACE_TARGETS.includes(p.target) ? PLACE_RELATIONSHIP : null,
          crosswalk: p.target === 'external.id' ? { external_system: ctx.source_system ?? '' } : null,
          alternatives: [
            { target: existing.target, confidence: existing.confidence, reason: `deterministic match: ${existing.reason}` },
            ...(p.alternatives ?? []),
          ],
        });
      }
    } catch (err) {
      // A suggestion pass is an assist, not a dependency. If the model is down,
      // over budget or slow, the importer still gets the deterministic mapping.
      console.warn(
        `[sdk-import] mapping assistant unavailable, falling back to deterministic suggestions: ${(err as Error).message}`,
      );
    }
  }

  return [...base.values()];
}

/** Raised when a confirmation names a column the preview never produced. */
export class UnknownMappingColumn extends Error {
  readonly status = 422;
  readonly code = 'UNKNOWN_MAPPING_COLUMN';
  constructor(public source_column: string) {
    super(`[sdk-import] no column named '${source_column}' in this run's preview`);
    this.name = 'UnknownMappingColumn';
  }
}

/** Raised when a mapping targets a value outside the canonical vocabulary. */
export class UnknownMappingTarget extends Error {
  readonly status = 422;
  readonly code = 'UNKNOWN_MAPPING_TARGET';
  constructor(public target: string) {
    super(`[sdk-import] '${target}' is not a canonical mapping target`);
    this.name = 'UnknownMappingTarget';
  }
}

export interface ConfirmationInput {
  source_column: string;
  target: CanonicalTarget;
  confirmed_by: string;
  external_system?: string;
}

/**
 * Apply a human's explicit per-field decisions to a suggestion set.
 *
 * Only the columns named here become confirmed. Everything else stays inert, so
 * a partially-reviewed mapping commits only the part that was actually reviewed
 * — the alternative (confirm-all-on-save) is how unreviewed guesses reach
 * production.
 */
export function confirmMapping(
  suggestions: MappingSuggestion[],
  confirmations: ConfirmationInput[],
  validTargets: readonly CanonicalTarget[],
): Record<string, FieldMapping> {
  const byColumn = new Map(suggestions.map((s) => [s.source_column, s]));
  const out: Record<string, FieldMapping> = {};

  for (const s of suggestions) {
    const { alternatives: _alternatives, ...mapping } = s;
    out[s.source_column] = { ...mapping, confirmed: false };
  }

  const now = new Date().toISOString();
  for (const c of confirmations) {
    const s = byColumn.get(c.source_column);
    if (!s) throw new UnknownMappingColumn(c.source_column);
    if (!validTargets.includes(c.target)) throw new UnknownMappingTarget(c.target);
    out[c.source_column] = {
      ...out[c.source_column],
      target: c.target,
      // A human decision is its own justification, and recording who made it is
      // what makes the mapping auditable later.
      reason:
        c.target === s.target
          ? `confirmed by ${c.confirmed_by}: ${s.reason}`
          : `overridden by ${c.confirmed_by} (assistant proposed ${s.target}: ${s.reason})`,
      proposed_by: c.target === s.target ? s.proposed_by : 'human',
      confidence: c.target === s.target ? s.confidence : 1,
      confirmed: true,
      confirmed_by: c.confirmed_by,
      confirmed_at: now,
      relationship: PLACE_TARGETS.includes(c.target) ? PLACE_RELATIONSHIP : null,
      crosswalk:
        c.target === 'external.id'
          ? { external_system: c.external_system ?? s.crosswalk?.external_system ?? '' }
          : null,
    };
  }

  return out;
}

/** Columns a commit would act on: confirmed and actually targeted somewhere. */
export function confirmedMappings(field_map: Record<string, FieldMapping>): FieldMapping[] {
  return Object.values(field_map).filter((m) => m.confirmed && m.target !== 'unmapped');
}
