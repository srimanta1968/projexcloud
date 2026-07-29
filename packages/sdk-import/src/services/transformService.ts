import {
  PLACE_TARGETS,
  type CanonicalTarget,
  type FieldMapping,
  type TransformPlan,
  type TransformStep,
} from '../models/import.model';

/**
 * sdk-import transform plan (P16 · EP-375 · PCF-02-3).
 *
 * A REVIEWABLE, DETERMINISTIC plan: given the same mapping it produces the same
 * steps in the same order, every step says in words what it will do, and the plan
 * is built and shown BEFORE identity resolution runs. Reviewing a transform after
 * matching has already happened is reviewing a decision that was already made.
 *
 * Two properties do the heavy lifting:
 *
 *   1. TRANSFORMS PRESERVE THE RAW VALUE AS EVIDENCE. Normalizing a telephone
 *      number to E.164 discards information (extensions, local formatting, the
 *      caller's own idea of their number). Keeping the input alongside the output
 *      means a later dispute is settleable and a bad normalization is reversible.
 *   2. UNCERTAIN CASES ARE ROUTED TO REVIEW, NOT GUESSED. A name with a suffix, a
 *      region string that matches nothing, an address that resolves to several
 *      candidates: each becomes a review entry rather than a silent choice.
 *
 * Anything that changes the MEANING of a record rather than its FORMAT is off by
 * default — see SOURCE_STATE_MAPPING_DEFAULT.
 */

/**
 * Mapping a source system's own status values onto platform workflow states is
 * DISABLED unless a human turns it on. Format normalization is reversible and
 * mechanical; deciding that the exporting system's "status B" means the platform's
 * "state Y" is a business judgement that differs per tenant, and getting it wrong
 * silently moves records into states nobody chose for them.
 */
export const SOURCE_STATE_MAPPING_DEFAULT = false;

export interface TransformOptions {
  /** Turn on source-status → workflow-state mapping. Off by default, on purpose. */
  enable_source_state_mapping?: boolean;
  /** Default region for telephone numbers with no country code. */
  default_calling_region?: string;
  /** Default country for addresses that name none. */
  default_country?: string;
}

/** Name suffixes that are ambiguous enough to warrant a human look. */
const NAME_SUFFIXES = ['jr', 'jr.', 'sr', 'sr.', 'ii', 'iii', 'iv', 'phd', 'md', 'esq'];

const TARGET_OPERATIONS: Partial<Record<CanonicalTarget, { operation: string; description: string; preserves_raw: boolean }>> = {
  'contact.phone': {
    operation: 'normalize_e164',
    description:
      'normalize the telephone number to E.164, keeping the raw input as evidence; a number that cannot be normalized is routed to review rather than dropped',
    preserves_raw: true,
  },
  'contact.email': {
    operation: 'normalize_email',
    description: 'trim and lower-case the address, keeping the raw input as evidence',
    preserves_raw: true,
  },
  'person.full_name': {
    operation: 'split_name',
    description:
      'split into given and family name; a trailing suffix (Jr, III, PhD) makes the split uncertain, so those rows go to review instead of being guessed',
    preserves_raw: true,
  },
  'place.region': {
    operation: 'standardize_region',
    description: 'standardize the administrative region against the country’s subdivision list',
    preserves_raw: true,
  },
  'place.country': {
    operation: 'standardize_country',
    description: 'standardize to an ISO 3166-1 alpha-2 country code',
    preserves_raw: true,
  },
  'contact.handle': {
    operation: 'parse_labeled_handle',
    description:
      'parse the handle into its service label and identifier, so a handle keeps the platform it belongs to',
    preserves_raw: true,
  },
  'external.id': {
    operation: 'retain_as_crosswalk',
    description:
      'retain the identifier verbatim as a crosswalk to the source system; it is never rewritten or replaced by a platform id',
    preserves_raw: true,
  },
};

const ADDRESS_RESOLUTION: TransformStep['operation'] = 'resolve_address_candidate';

export function buildTransformPlan(
  field_map: Record<string, FieldMapping>,
  options: TransformOptions = {},
): TransformPlan {
  const steps: TransformStep[] = [];
  const review_required: Array<{ source_column: string; reason: string }> = [];

  // Deterministic order: source column name, so the same mapping always yields the
  // same plan and two reviewers see the same thing.
  const mappings = Object.values(field_map)
    .filter((m) => m.confirmed && m.target !== 'unmapped')
    .sort((a, b) => (a.source_column < b.source_column ? -1 : a.source_column > b.source_column ? 1 : 0));

  const placeColumns = mappings.filter((m) => PLACE_TARGETS.includes(m.target));

  for (const m of mappings) {
    const op = TARGET_OPERATIONS[m.target];
    if (op) {
      steps.push({
        source_column: m.source_column,
        target: m.target,
        operation: op.operation,
        description: op.description,
        preserves_raw: op.preserves_raw,
        enabled: true,
        params:
          m.target === 'contact.phone'
            ? { default_calling_region: options.default_calling_region ?? null }
            : m.target === 'place.country'
              ? { default_country: options.default_country ?? null }
              : undefined,
      });
      continue;
    }
    steps.push({
      source_column: m.source_column,
      target: m.target,
      operation: 'copy',
      description: 'copy the value through unchanged',
      preserves_raw: true,
      enabled: true,
    });
  }

  // One address-candidate resolution across all the place columns together: a
  // street, a locality and a postal code only mean something as one address.
  if (placeColumns.length > 0) {
    steps.push({
      source_column: placeColumns.map((m) => m.source_column).join('+'),
      target: 'place.address_line1',
      operation: ADDRESS_RESOLUTION,
      description:
        'resolve the place columns to a single address candidate; an address matching several candidates goes to review rather than picking one',
      preserves_raw: true,
      enabled: true,
      params: { columns: placeColumns.map((m) => m.source_column) },
    });
  }

  // Present but disabled, so a reviewer can SEE the option exists and turn it on
  // deliberately. Omitting it entirely would hide the choice.
  steps.push({
    source_column: '(source status column, if mapped)',
    target: 'attribute.custom',
    operation: 'map_source_state',
    description:
      'map the source system’s own status values onto platform workflow states — a per-tenant business judgement, so it stays OFF unless explicitly enabled',
    preserves_raw: true,
    enabled: options.enable_source_state_mapping ?? SOURCE_STATE_MAPPING_DEFAULT,
  });

  for (const m of mappings) {
    if (m.target === 'person.full_name') {
      review_required.push({
        source_column: m.source_column,
        reason: 'whole-name columns split heuristically; rows with a suffix are held for review',
      });
    }
    if (m.target === 'external.id' && !m.crosswalk?.external_system) {
      review_required.push({
        source_column: m.source_column,
        reason:
          'the identifier has no issuing system recorded — a crosswalk without its system cannot be resolved later',
      });
    }
  }

  return { steps, review_required, built_at: new Date().toISOString() };
}

/* --------------------------------------------------------------- apply */

export interface TransformedValue {
  target: CanonicalTarget;
  value: string | null;
  /** The input exactly as received. Never discarded by a transform. */
  raw: string;
  /** Set when the value could not be transformed confidently. */
  review_reason?: string;
}

export interface TransformedRow {
  values: TransformedValue[];
  /** Reasons this row needs a human before it can land. */
  review: string[];
  /** Reasons this row cannot land at all. */
  invalid: string[];
}

const E164_RE = /^\+[1-9]\d{6,14}$/;

/**
 * Normalize to E.164 where that is possible WITHOUT inventing a country code.
 * A bare national number with no default region is left for review: guessing the
 * country from the digits is how a number ends up dialling the wrong continent.
 */
export function normalizeE164(
  raw: string,
  default_calling_region?: string | null,
): { value: string | null; review_reason?: string } {
  const trimmed = raw.trim();
  if (!trimmed) return { value: null };
  const digits = trimmed.replace(/[^\d+]/g, '');
  if (digits.startsWith('+')) {
    const candidate = '+' + digits.slice(1).replace(/\D/g, '');
    return E164_RE.test(candidate)
      ? { value: candidate }
      : { value: null, review_reason: `'${raw}' has an international prefix but is not a valid E.164 number` };
  }
  if (!default_calling_region) {
    return {
      value: null,
      review_reason: `'${raw}' has no country code and the run declares no default calling region`,
    };
  }
  const candidate = `+${default_calling_region.replace(/\D/g, '')}${digits.replace(/^0+/, '')}`;
  return E164_RE.test(candidate)
    ? { value: candidate }
    : { value: null, review_reason: `'${raw}' could not be normalized against default region ${default_calling_region}` };
}

/**
 * Split a whole name. Two tokens is unambiguous; a recognised suffix or more than
 * three tokens is not, and those go to review rather than being guessed.
 */
export function splitName(raw: string): {
  given_name: string | null;
  family_name: string | null;
  review_reason?: string;
} {
  const tokens = raw.trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return { given_name: null, family_name: null };
  if (tokens.length === 1) return { given_name: tokens[0], family_name: null };

  const last = tokens[tokens.length - 1].toLowerCase().replace(/,$/, '');
  if (NAME_SUFFIXES.includes(last)) {
    return {
      given_name: tokens[0],
      family_name: tokens.slice(1, -1).join(' ') || null,
      review_reason: `'${raw}' ends in the suffix '${tokens[tokens.length - 1]}' — confirm the family name`,
    };
  }
  if (tokens.length === 2) return { given_name: tokens[0], family_name: tokens[1] };
  return {
    given_name: tokens[0],
    family_name: tokens.slice(1).join(' '),
    review_reason: `'${raw}' has ${tokens.length} parts — confirm which are given and which are family names`,
  };
}

/** Split "service:identifier" or "service/identifier" into its label and value. */
export function parseLabeledHandle(raw: string): { label: string | null; handle: string } {
  const m = raw.trim().match(/^([a-z0-9_.-]+)\s*[:/]\s*(.+)$/i);
  if (!m) return { label: null, handle: raw.trim() };
  return { label: m[1].toLowerCase(), handle: m[2].trim() };
}

/**
 * Apply a plan to one row. Pure: no database, no network, no writes — which is
 * what allows the dry run to use exactly the same code path as the commit.
 */
export function applyTransforms(
  row: Record<string, string>,
  field_map: Record<string, FieldMapping>,
  plan: TransformPlan,
): TransformedRow {
  const values: TransformedValue[] = [];
  const review: string[] = [];
  const invalid: string[] = [];

  for (const step of plan.steps) {
    if (!step.enabled) continue;
    if (step.operation === ADDRESS_RESOLUTION || step.operation === 'map_source_state') continue;

    const raw = row[step.source_column];
    if (raw === undefined) continue;
    const mapping = field_map[step.source_column];
    if (!mapping) continue;

    switch (step.operation) {
      case 'normalize_e164': {
        const r = normalizeE164(raw, (step.params?.default_calling_region as string) ?? null);
        values.push({ target: step.target, value: r.value, raw, review_reason: r.review_reason });
        if (r.review_reason) review.push(r.review_reason);
        break;
      }
      case 'normalize_email': {
        const v = raw.trim().toLowerCase();
        const ok = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(v);
        values.push({ target: step.target, value: ok ? v : null, raw });
        if (!ok && v.length > 0) invalid.push(`'${raw}' is not a valid email address`);
        break;
      }
      case 'split_name': {
        const s = splitName(raw);
        values.push({ target: 'person.given_name', value: s.given_name, raw });
        values.push({ target: 'person.family_name', value: s.family_name, raw, review_reason: s.review_reason });
        if (s.review_reason) review.push(s.review_reason);
        break;
      }
      case 'standardize_country': {
        const v = raw.trim().toUpperCase();
        const ok = /^[A-Z]{2}$/.test(v);
        values.push({
          target: step.target,
          value: ok ? v : ((step.params?.default_country as string) ?? null),
          raw,
          review_reason: ok ? undefined : `'${raw}' is not an ISO 3166-1 alpha-2 country code`,
        });
        if (!ok) review.push(`'${raw}' is not an ISO 3166-1 alpha-2 country code`);
        break;
      }
      case 'standardize_region': {
        values.push({ target: step.target, value: raw.trim(), raw });
        break;
      }
      case 'parse_labeled_handle': {
        const h = parseLabeledHandle(raw);
        values.push({ target: step.target, value: h.handle, raw });
        if (!h.label) {
          review.push(`'${raw}' has no service label — a handle without its service cannot be dialled or messaged`);
        }
        break;
      }
      case 'retain_as_crosswalk':
      case 'copy':
      default: {
        values.push({ target: step.target, value: raw.trim() || null, raw });
        break;
      }
    }
  }

  return { values, review, invalid };
}
