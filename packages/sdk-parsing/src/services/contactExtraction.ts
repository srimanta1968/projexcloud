import { lookupExtractionSchema } from '@projexlight/sdk-taxonomy';
import {
  despeak,
  getContactBackend,
  type ContactCandidate,
  type ContactSourceKind,
  type FieldProposal,
} from './contactBackends';

/**
 * Contact extraction orchestrator (P16 · sdk-parsing).
 *
 * Three rules, in the order they matter:
 *
 * 1. THE LOCAL PARSER ALWAYS RUNS FIRST, AND THE LLM IS OPT-IN. Not "prefer local" —
 *    the deterministic pass is unconditional, and the model is reached only when required
 *    fields are STILL unresolved after it AND the caller explicitly asked. Most captures
 *    are a pasted signature or a vCard, where a regex is both cheaper and more reliable
 *    than a model; sending every paste to an LLM would spend money and tenant data to do
 *    worse. Every skip is reported with a reason so the decision is auditable rather than
 *    invisible.
 *
 * 2. NOTHING IS EVER FABRICATED. Every proposal must carry an evidence span that, when
 *    sliced out of the raw input, actually yields the value. This is re-checked here
 *    mechanically — a backend's word is not taken for it. Proposals that fail are DROPPED
 *    and reported in `rejected`, never silently kept. The guard runs on local and LLM
 *    output alike, which is the point: a model asked for "the company name" will happily
 *    supply a plausible one that appears nowhere in the input, and this is the thing that
 *    stops it reaching the caller.
 *
 * 3. SCHEMAS RESOLVE TENANT-FIRST WITH PLATFORM FALLBACK, via sdk-taxonomy's existing
 *    lookupExtractionSchema, which already orders tenant versions above platform ones. A
 *    second resolver here would be a second thing to keep correct.
 */

/** What a caller may ask to be filled. */
export const DEFAULT_CONTACT_FIELDS = [
  'full_name',
  'email',
  'phone',
  'organization',
  'job_title',
  'website',
] as const;

/** The document_kind sdk-taxonomy is keyed by for this surface. */
export const CONTACT_DOCUMENT_KIND = 'contact';

export interface ContactFieldSpec {
  name: string;
  required?: boolean;
  type?: string;
}

export interface ResolvedContactSchema {
  document_kind: string;
  taxonomy_version_id: string | null;
  /** Where the schema actually came from — surfaced so a tenant can tell. */
  source: 'tenant' | 'platform' | 'builtin';
  field_specs: ContactFieldSpec[];
}

export interface RejectedProposal {
  field: string;
  value: string;
  origin: 'local' | 'llm';
  reason: string;
}

export interface ExtractContactsInput {
  tenant_id: string;
  source_kind: ContactSourceKind;
  /** The text every evidence span indexes into. */
  raw: string;
  /** Structured payload for surfaces that provide one (mobile picker). */
  structured?: unknown;
  /**
   * Opt-in for the LLM adjunct. Default false: reaching a model must be a decision the
   * caller made, not one this SDK made on their behalf with their data.
   */
  allow_llm?: boolean;
  /** Override the resolved schema's required fields. */
  required_fields?: string[];
  taxonomy_version_id?: string;
}

export interface ExtractContactsResult {
  source_kind: ContactSourceKind;
  candidates: ContactCandidate[];
  schema: ResolvedContactSchema;
  /** Required fields still unresolved after every pass that ran. */
  unresolved_required: string[];
  llm_invoked: boolean;
  /** Why the model was or was not called — always populated. */
  llm_reason: string;
  /** Proposals the evidence guard removed. Reported, never silently dropped. */
  rejected: RejectedProposal[];
}

/**
 * The LLM adjunct. Injected rather than imported so this package does not hard-depend on a
 * model being reachable, and so tests can prove the gating without a network call.
 */
export type ContactLlmAdjunct = (input: {
  tenant_id: string;
  raw: string;
  missing_fields: string[];
  source_kind: ContactSourceKind;
}) => Promise<FieldProposal[]>;

let _llm: ContactLlmAdjunct | null = null;

/** Wire the sdk-ai-gateway-backed adjunct at service startup. */
export function setContactLlmAdjunct(fn: ContactLlmAdjunct | null): void {
  _llm = fn;
}

export function getContactLlmAdjunct(): ContactLlmAdjunct | null {
  return _llm;
}

// ---------------------------------------------------------------------------
// The fabrication guard
// ---------------------------------------------------------------------------

/**
 * Reduce text to what a comparison should care about: case, punctuation and spacing all
 * vary between how a value is written and how it is displayed, and none of them change
 * whether the value was actually present.
 */
function normalizeForEvidence(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * Does the evidence actually support the value?
 *
 * Checked in three widening steps, each one a rule that can be replayed by hand:
 *   1. the span is in range and non-empty;
 *   2. the normalised slice contains the normalised value — the ordinary case;
 *   3. for transcripts only, the same after applying the spoken-form substitutions,
 *      so "john at example dot com" supports "john@example.com".
 *
 * Anything else is a claim the input does not back, whatever produced it.
 */
export function verifyEvidence(
  raw: string,
  proposal: FieldProposal,
  opts: { allowSpokenForm?: boolean } = {},
): { ok: true } | { ok: false; reason: string } {
  const { start, end } = proposal.evidence ?? ({} as FieldProposal['evidence']);
  if (typeof start !== 'number' || typeof end !== 'number') {
    return { ok: false, reason: 'proposal carries no evidence span' };
  }
  if (start < 0 || end > raw.length || end <= start) {
    return { ok: false, reason: `evidence span [${start}, ${end}) is outside the input` };
  }
  const value = (proposal.value ?? '').trim();
  if (!value) return { ok: false, reason: 'proposal has an empty value' };

  const slice = raw.slice(start, end);
  const nv = normalizeForEvidence(value);
  if (!nv) return { ok: false, reason: 'value normalises to nothing' };

  if (normalizeForEvidence(slice).includes(nv)) return { ok: true };
  if (opts.allowSpokenForm && normalizeForEvidence(despeak(slice)).includes(nv)) {
    return { ok: true };
  }
  return {
    ok: false,
    reason: `value "${value}" does not appear in its evidence span "${slice}" — not fabricating it`,
  };
}

function applyGuard(
  raw: string,
  candidates: ContactCandidate[],
  allowSpokenForm: boolean,
  rejected: RejectedProposal[],
): ContactCandidate[] {
  return candidates.map((c) => ({
    index: c.index,
    proposals: c.proposals.filter((p) => {
      const v = verifyEvidence(raw, p, { allowSpokenForm });
      if (v.ok) return true;
      rejected.push({ field: p.field, value: p.value, origin: p.origin, reason: v.reason });
      return false;
    }),
  }));
}

// ---------------------------------------------------------------------------
// Schema resolution (AC4)
// ---------------------------------------------------------------------------

const BUILTIN_CONTACT_SPECS: ContactFieldSpec[] = [
  { name: 'full_name', required: true, type: 'string' },
  { name: 'email', required: true, type: 'string' },
  { name: 'phone', required: false, type: 'string' },
  { name: 'organization', required: false, type: 'string' },
  { name: 'job_title', required: false, type: 'string' },
  { name: 'website', required: false, type: 'string' },
];

/**
 * Tenant-first, platform fallback, built-in last.
 *
 * The first two come from sdk-taxonomy, whose query already ranks tenant versions above
 * platform ones. The built-in exists so a fresh install extracts contacts before anyone
 * has seeded a taxonomy — a hard failure there would make the feature undemonstrable on
 * day one. `source` is returned so the caller can tell which of the three answered, rather
 * than having to infer it.
 */
export async function resolveContactSchema(input: {
  tenant_id: string;
  taxonomy_version_id?: string;
}): Promise<ResolvedContactSchema> {
  try {
    const row = await lookupExtractionSchema({
      tenant_id: input.tenant_id,
      document_kind: CONTACT_DOCUMENT_KIND,
    });
    if (row) {
      const defs = (row as { field_definitions?: unknown }).field_definitions;
      const specs = normalizeFieldDefinitions(defs);
      if (specs.length) {
        return {
          document_kind: CONTACT_DOCUMENT_KIND,
          taxonomy_version_id: (row as { taxonomy_version_id?: string }).taxonomy_version_id ?? null,
          // lookupExtractionSchema prefers a tenant version and falls back to the platform
          // one; a tenant_id on the returned version is what distinguishes them.
          source: (row as { tenant_id?: string | null }).tenant_id ? 'tenant' : 'platform',
          field_specs: specs,
        };
      }
    }
  } catch (err) {
    // A taxonomy outage must not take contact capture down with it — fall through to the
    // built-in and say so, rather than failing a paste the local parser could handle.
    console.warn('[sdk-parsing] contact schema lookup failed, using builtin:', (err as Error).message);
  }

  return {
    document_kind: CONTACT_DOCUMENT_KIND,
    taxonomy_version_id: input.taxonomy_version_id ?? null,
    source: 'builtin',
    field_specs: BUILTIN_CONTACT_SPECS,
  };
}

function normalizeFieldDefinitions(defs: unknown): ContactFieldSpec[] {
  if (!defs) return [];
  const arr = Array.isArray(defs)
    ? defs
    : typeof defs === 'object'
      ? Object.entries(defs as Record<string, unknown>).map(([name, v]) => ({
          name,
          ...(typeof v === 'object' && v ? (v as Record<string, unknown>) : {}),
        }))
      : [];
  return arr
    .map((d) => {
      const o = d as Record<string, unknown>;
      const name = typeof o.name === 'string' ? o.name : null;
      if (!name) return null;
      return {
        name,
        required: Boolean(o.required),
        ...(typeof o.type === 'string' ? { type: o.type } : {}),
      } as ContactFieldSpec;
    })
    .filter((x): x is ContactFieldSpec => x !== null);
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

function resolvedFieldNames(candidates: ContactCandidate[]): Set<string> {
  const s = new Set<string>();
  for (const c of candidates) for (const p of c.proposals) s.add(p.field);
  return s;
}

export async function extractContacts(
  input: ExtractContactsInput,
): Promise<ExtractContactsResult> {
  if (!input.tenant_id) throw new Error('[sdk-parsing] extractContacts requires tenant_id');
  if (typeof input.raw !== 'string') {
    throw new Error('[sdk-parsing] extractContacts requires raw text for evidence spans');
  }

  const schema = await resolveContactSchema({
    tenant_id: input.tenant_id,
    taxonomy_version_id: input.taxonomy_version_id,
  });
  const required = input.required_fields
    ?? schema.field_specs.filter((f) => f.required).map((f) => f.name);

  const rejected: RejectedProposal[] = [];
  const allowSpokenForm = input.source_kind === 'VOICE_TRANSCRIPT';

  // ---- Pass 1: the deterministic parser. Unconditional. -------------------
  const backend = getContactBackend(input.source_kind);
  let candidates = applyGuard(
    input.raw,
    backend.extract({ raw: input.raw, structured: input.structured }),
    allowSpokenForm,
    rejected,
  );

  let resolved = resolvedFieldNames(candidates);
  let missing = required.filter((f) => !resolved.has(f));

  // ---- Pass 2: the LLM adjunct. Opt-in, and only if still needed. ---------
  let llm_invoked = false;
  let llm_reason: string;

  if (missing.length === 0) {
    llm_reason = 'not needed — the local parser resolved every required field';
  } else if (!input.allow_llm) {
    llm_reason = `skipped — ${missing.length} required field(s) unresolved (${missing.join(', ')}) but the caller did not opt in (allow_llm=false)`;
  } else if (!_llm) {
    llm_reason = 'requested but no adjunct is wired — call setContactLlmAdjunct() at startup';
  } else {
    try {
      const proposals = await _llm({
        tenant_id: input.tenant_id,
        raw: input.raw,
        missing_fields: missing,
        source_kind: input.source_kind,
      });
      llm_invoked = true;

      // The model's output goes through the SAME guard as everything else. This is the
      // step that turns "the LLM might hallucinate a company name" into a dropped
      // proposal with a stated reason instead of a wrong contact in the CRM.
      const llmCandidates = applyGuard(
        input.raw,
        [{ index: 0, proposals: proposals.map((p) => ({ ...p, origin: 'llm' as const })) }],
        allowSpokenForm,
        rejected,
      );

      // Merge into the primary candidate; never overwrite a local proposal for the same
      // field, because a deterministic read beats a model's guess by construction.
      const extra = llmCandidates[0]?.proposals ?? [];
      if (extra.length) {
        if (candidates.length === 0) candidates = [{ index: 0, proposals: [] }];
        const have = new Set(candidates[0].proposals.map((p) => p.field));
        candidates[0].proposals.push(...extra.filter((p) => !have.has(p.field)));
      }
      llm_reason = `invoked for ${missing.join(', ')}`;
    } catch (err) {
      llm_reason = `adjunct failed (${(err as Error).message}) — local results returned unchanged`;
    }
  }

  resolved = resolvedFieldNames(candidates);
  missing = required.filter((f) => !resolved.has(f));

  return {
    source_kind: input.source_kind,
    candidates,
    schema,
    unresolved_required: missing,
    llm_invoked,
    llm_reason,
    rejected,
  };
}

export interface ExtractContactsBatchItem
  extends Omit<ExtractContactsInput, 'tenant_id' | 'allow_llm'> {
  /** Per-item id echoed back so a caller can correlate without relying on order. */
  id?: string;
}

export interface BatchResultEntry {
  id: string | null;
  ok: boolean;
  result?: ExtractContactsResult;
  error?: string;
}

/**
 * Batch extraction.
 *
 * One failing item does not fail the batch: a caller pasting forty signatures should not
 * lose thirty-nine because one was malformed. Failures are returned in place, with their
 * id, so the caller can retry exactly those.
 */
export async function extractContactsBatch(input: {
  tenant_id: string;
  allow_llm?: boolean;
  items: ExtractContactsBatchItem[];
}): Promise<{ results: BatchResultEntry[]; ok_count: number; failed_count: number }> {
  if (!Array.isArray(input.items) || input.items.length === 0) {
    throw new Error('[sdk-parsing] extractContactsBatch requires a non-empty items array');
  }

  const results: BatchResultEntry[] = [];
  for (const item of input.items) {
    try {
      const result = await extractContacts({
        ...item,
        tenant_id: input.tenant_id,
        allow_llm: input.allow_llm,
      });
      results.push({ id: item.id ?? null, ok: true, result });
    } catch (err) {
      results.push({ id: item.id ?? null, ok: false, error: (err as Error).message });
    }
  }
  return {
    results,
    ok_count: results.filter((r) => r.ok).length,
    failed_count: results.filter((r) => !r.ok).length,
  };
}
