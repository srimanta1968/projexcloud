/**
 * Deterministic contact-extraction backends (P16 · sdk-parsing · contact capture).
 *
 * One backend per capture surface. Every one returns PROPOSALS — never a finished
 * contact — because extraction guesses and a human confirms; a service that returned a
 * "contact" would be asserting a certainty it does not have.
 *
 * Two rules hold across all of them:
 *
 *   * Every proposal carries an EVIDENCE SPAN into the raw input. Not a flag saying the
 *     value came from somewhere — the actual offsets, so a reviewer can be shown the
 *     characters the value was read from. This is also what makes the fabrication guard
 *     in contactExtraction.ts able to re-check the claim mechanically.
 *
 *   * Values are taken VERBATIM from the input wherever possible. Reformatting a phone
 *     number into E.164 here would produce a value that no longer appears in the source,
 *     making it indistinguishable from an invented one. Normalisation belongs to the
 *     consumer, which knows the country context; this layer's job is to be checkable.
 */

export type ContactSourceKind =
  | 'SMART_PASTE'
  | 'EMAIL_SIGNATURE'
  | 'BUSINESS_CARD_OCR'
  | 'VCARD'
  | 'VCARD_MULTI'
  | 'MOBILE_CONTACTS'
  | 'BROWSER_SELECTION'
  | 'VOICE_TRANSCRIPT';

export const CONTACT_SOURCE_KINDS: ContactSourceKind[] = [
  'SMART_PASTE',
  'EMAIL_SIGNATURE',
  'BUSINESS_CARD_OCR',
  'VCARD',
  'VCARD_MULTI',
  'MOBILE_CONTACTS',
  'BROWSER_SELECTION',
  'VOICE_TRANSCRIPT',
];

export interface EvidenceSpan {
  /** Character offset into the RAW input, inclusive. */
  start: number;
  /** Character offset into the RAW input, exclusive. */
  end: number;
  /** The exact slice, carried so a reviewer sees what was read without re-slicing. */
  snippet: string;
}

export interface FieldProposal {
  field: string;
  /** As it appears in the input. Normalisation is the consumer's job, not this layer's. */
  value: string;
  /** 0..1. Reflects how unambiguous the SIGNAL was, not how much we like the answer. */
  confidence: number;
  evidence: EvidenceSpan;
  origin: 'local' | 'llm';
  /** Set when the surface implies a subtype, e.g. work vs mobile phone. */
  qualifier?: string;
}

export interface ContactCandidate {
  /** Position in the input — a vCard file or a device export can hold many contacts. */
  index: number;
  proposals: FieldProposal[];
}

export interface ContactBackendInput {
  /** The raw text every evidence span indexes into. */
  raw: string;
  /** Structured payload for surfaces that supply one (mobile contact picker). */
  structured?: unknown;
}

export interface ContactBackend {
  kind: ContactSourceKind;
  extract(input: ContactBackendInput): ContactCandidate[];
}

// ---------------------------------------------------------------------------
// Shared matchers
// ---------------------------------------------------------------------------

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
// Deliberately conservative: 7+ digits with common separators. A looser pattern turns
// order numbers and dates into phone numbers, and a wrong contact detail is worse than a
// missing one the user can type.
const PHONE_RE = /(?:\+?\d[\d\s().-]{6,}\d)/g;
const URL_RE = /\b(?:https?:\/\/|www\.)[^\s<>"')]+/gi;

const TITLE_WORDS = [
  'ceo', 'cto', 'cfo', 'coo', 'founder', 'co-founder', 'president', 'director',
  'manager', 'head of', 'vp', 'vice president', 'engineer', 'developer', 'designer',
  'consultant', 'analyst', 'partner', 'principal', 'lead', 'architect', 'specialist',
  'coordinator', 'administrator', 'officer', 'supervisor', 'account executive',
];

const ORG_SUFFIXES = [
  'inc', 'inc.', 'llc', 'ltd', 'ltd.', 'limited', 'gmbh', 'corp', 'corp.', 'co',
  'co.', 'plc', 'ag', 'bv', 'sa', 'pty', 'llp', 'group', 'holdings', 'technologies',
  'solutions', 'systems', 'labs', 'studio', 'agency', 'partners',
];

function span(raw: string, start: number, length: number): EvidenceSpan {
  const end = start + length;
  return { start, end, snippet: raw.slice(start, end) };
}

function matchAll(raw: string, re: RegExp): Array<{ text: string; index: number }> {
  const out: Array<{ text: string; index: number }> = [];
  const r = new RegExp(re.source, re.flags.includes('g') ? re.flags : `${re.flags}g`);
  let m: RegExpExecArray | null;
  while ((m = r.exec(raw)) !== null) {
    out.push({ text: m[0], index: m.index });
    if (m[0].length === 0) r.lastIndex += 1;
  }
  return out;
}

/** Digits only — used to judge whether a phone candidate is plausible, never to rewrite it. */
function digitCount(s: string): number {
  return (s.match(/\d/g) ?? []).length;
}

function emailProposals(raw: string, origin: 'local' = 'local'): FieldProposal[] {
  return matchAll(raw, EMAIL_RE).map((m) => ({
    field: 'email',
    value: m.text,
    // An address matching the RFC-ish shape is about as unambiguous as text gets.
    confidence: 0.95,
    evidence: span(raw, m.index, m.text.length),
    origin,
  }));
}

function phoneProposals(raw: string): FieldProposal[] {
  return matchAll(raw, PHONE_RE)
    .map((m) => ({ ...m, text: m.text.trim() }))
    .filter((m) => {
      const d = digitCount(m.text);
      // 7..15: shorter is an order number, longer than E.164's max is a run of digits.
      return d >= 7 && d <= 15;
    })
    .map((m) => ({
      field: 'phone',
      value: m.text,
      // Lower than email: digit runs are genuinely ambiguous in free text.
      confidence: 0.75,
      evidence: span(raw, m.index, m.text.length),
      origin: 'local' as const,
    }));
}

function urlProposals(raw: string): FieldProposal[] {
  return matchAll(raw, URL_RE).map((m) => ({
    field: 'website',
    value: m.text.replace(/[.,;]$/, ''),
    confidence: 0.8,
    evidence: span(raw, m.index, m.text.replace(/[.,;]$/, '').length),
    origin: 'local' as const,
  }));
}

function titleProposals(raw: string): FieldProposal[] {
  const out: FieldProposal[] = [];
  const lower = raw.toLowerCase();
  for (const word of TITLE_WORDS) {
    let from = 0;
    for (;;) {
      const idx = lower.indexOf(word, from);
      if (idx === -1) break;
      from = idx + word.length;
      // Word boundaries, so 'lead' does not match inside 'leadership'.
      const before = idx === 0 ? ' ' : raw[idx - 1];
      const after = idx + word.length >= raw.length ? ' ' : raw[idx + word.length];
      if (/[A-Za-z]/.test(before) || /[A-Za-z]/.test(after)) continue;
      // Take the whole line as the title: "Head of" alone is not a job title, and the
      // line it sits on is what a human would read as one.
      const lineStart = raw.lastIndexOf('\n', idx) + 1;
      const lineEndRaw = raw.indexOf('\n', idx);
      const lineEnd = lineEndRaw === -1 ? raw.length : lineEndRaw;
      const line = raw.slice(lineStart, lineEnd).trim();
      if (!line || line.length > 80) continue;
      const startInRaw = lineStart + raw.slice(lineStart, lineEnd).indexOf(line);
      out.push({
        field: 'job_title',
        value: line,
        confidence: 0.6,
        evidence: span(raw, startInRaw, line.length),
        origin: 'local',
      });
      break;
    }
  }
  return dedupeByValue(out);
}

function organizationProposals(raw: string): FieldProposal[] {
  const out: FieldProposal[] = [];
  const lines = splitLines(raw);
  for (const { text, start } of lines) {
    const t = text.trim();
    if (!t || t.length > 80) continue;
    const words = t.toLowerCase().replace(/[,]/g, '').split(/\s+/);
    const last = words[words.length - 1];
    if (!ORG_SUFFIXES.includes(last)) continue;
    const startInRaw = start + text.indexOf(t);
    out.push({
      field: 'organization',
      value: t,
      // A legal suffix is a strong hint but not proof — "Acme Group" could be a team name.
      confidence: 0.7,
      evidence: span(raw, startInRaw, t.length),
      origin: 'local',
    });
  }
  return dedupeByValue(out);
}

function splitLines(raw: string): Array<{ text: string; start: number }> {
  const out: Array<{ text: string; start: number }> = [];
  let start = 0;
  for (const line of raw.split('\n')) {
    out.push({ text: line, start });
    start += line.length + 1;
  }
  return out;
}

function dedupeByValue(list: FieldProposal[]): FieldProposal[] {
  const seen = new Set<string>();
  return list.filter((p) => {
    const k = `${p.field}::${p.value.toLowerCase()}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/**
 * Person name. The weakest signal in the file, and priced accordingly.
 *
 * Heuristic: the first short line of 2–4 capitalised words that is not already claimed by
 * another field. It is offered at low confidence rather than withheld, because a name a
 * human can accept with one click beats a blank field they must type — but the confidence
 * has to say plainly that this is a guess.
 */
function nameProposals(raw: string, claimed: FieldProposal[]): FieldProposal[] {
  const claimedRanges = claimed.map((p) => [p.evidence.start, p.evidence.end] as const);
  const overlaps = (s: number, e: number) =>
    claimedRanges.some(([cs, ce]) => s < ce && e > cs);

  for (const { text, start } of splitLines(raw)) {
    const t = text.trim();
    if (!t || t.length > 60) continue;
    if (t.includes('@') || /\d/.test(t)) continue;
    const words = t.split(/\s+/);
    if (words.length < 2 || words.length > 4) continue;
    if (!words.every((w) => /^[A-Z][A-Za-z'’.-]*$/.test(w))) continue;
    const startInRaw = start + text.indexOf(t);
    if (overlaps(startInRaw, startInRaw + t.length)) continue;
    return [
      {
        field: 'full_name',
        value: t,
        confidence: 0.55,
        evidence: span(raw, startInRaw, t.length),
        origin: 'local',
      },
    ];
  }
  return [];
}

/** The common free-text pass, shared by every unstructured surface. */
function freeTextCandidate(raw: string): ContactCandidate {
  const emails = emailProposals(raw);
  const phones = phoneProposals(raw);
  const urls = urlProposals(raw);
  const titles = titleProposals(raw);
  const orgs = organizationProposals(raw);
  const claimed = [...emails, ...phones, ...urls, ...titles, ...orgs];
  const names = nameProposals(raw, claimed);
  return { index: 0, proposals: [...names, ...claimed] };
}

// ---------------------------------------------------------------------------
// Backends
// ---------------------------------------------------------------------------

export const smartPasteBackend: ContactBackend = {
  kind: 'SMART_PASTE',
  extract: ({ raw }) => [freeTextCandidate(raw)],
};

export const browserSelectionBackend: ContactBackend = {
  kind: 'BROWSER_SELECTION',
  extract: ({ raw }) => [freeTextCandidate(raw)],
};

/**
 * Business-card OCR text. Same matchers as smart paste, but every confidence is scaled
 * down: OCR mangles characters, so the same regex hit is genuinely less trustworthy here
 * than in text a human pasted. Reporting equal confidence would hide a real difference in
 * how often these are wrong.
 */
export const businessCardBackend: ContactBackend = {
  kind: 'BUSINESS_CARD_OCR',
  extract: ({ raw }) => {
    const c = freeTextCandidate(raw);
    return [
      {
        index: 0,
        proposals: c.proposals.map((p) => ({
          ...p,
          confidence: Math.round(p.confidence * 0.85 * 100) / 100,
        })),
      },
    ];
  },
};

/**
 * Email signature. Differs from plain text in two ways that matter.
 *
 *   * MULTI-HANDLE: a signature routinely carries several addresses and numbers (work,
 *     mobile, support). They are all kept and qualified rather than collapsed to one —
 *     picking "the" email here would be a guess the consumer is better placed to make.
 *
 *   * ORGANISATION CANDIDATE: when no line carries a legal suffix, the email domain is
 *     offered as a candidate — but ONLY as an org_candidate field with its evidence
 *     pointing at the domain characters inside the address. It is never promoted to
 *     `organization`, because "acme.com" is evidence of a company, not its name.
 */
export const emailSignatureBackend: ContactBackend = {
  kind: 'EMAIL_SIGNATURE',
  extract: ({ raw }) => {
    const base = freeTextCandidate(raw);
    const proposals = [...base.proposals];

    // Qualify handles by the label on their own line, when there is one.
    for (const p of proposals) {
      if (p.field !== 'phone' && p.field !== 'email') continue;
      const lineStart = raw.lastIndexOf('\n', p.evidence.start) + 1;
      const label = raw.slice(lineStart, p.evidence.start).toLowerCase();
      if (/\bmob|\bcell/.test(label)) p.qualifier = 'mobile';
      else if (/\bwork|\boffice|\btel\b|\bdirect/.test(label)) p.qualifier = 'work';
      else if (/\bhome/.test(label)) p.qualifier = 'home';
      else if (/\bfax/.test(label)) p.qualifier = 'fax';
    }

    const hasOrg = proposals.some((p) => p.field === 'organization');
    if (!hasOrg) {
      const firstEmail = proposals.find((p) => p.field === 'email');
      if (firstEmail) {
        const at = firstEmail.value.indexOf('@');
        if (at > -1) {
          const domain = firstEmail.value.slice(at + 1);
          const domainStart = firstEmail.evidence.start + at + 1;
          proposals.push({
            field: 'org_candidate',
            value: domain,
            // Low on purpose: this is a hint for the consumer to resolve, not a name.
            confidence: 0.4,
            evidence: span(raw, domainStart, domain.length),
            origin: 'local',
            qualifier: 'from_email_domain',
          });
        }
      }
    }
    return [{ index: 0, proposals }];
  },
};

// ---------------------------------------------------------------------------
// vCard
// ---------------------------------------------------------------------------

const VCARD_FIELD_MAP: Record<string, string> = {
  FN: 'full_name',
  EMAIL: 'email',
  TEL: 'phone',
  ORG: 'organization',
  TITLE: 'job_title',
  URL: 'website',
  ADR: 'address',
  NOTE: 'note',
};

/**
 * vCard is a declared format, so a parsed property is as close to fact as this file gets —
 * hence the high confidence. Evidence still points at the VALUE characters only, not the
 * whole property line, so a reviewer sees exactly what was taken.
 */
function parseVCards(raw: string): ContactCandidate[] {
  const candidates: ContactCandidate[] = [];
  const beginRe = /BEGIN:VCARD/gi;
  let m: RegExpExecArray | null;
  let index = 0;

  while ((m = beginRe.exec(raw)) !== null) {
    const cardStart = m.index;
    const endIdx = raw.toUpperCase().indexOf('END:VCARD', cardStart);
    const cardEnd = endIdx === -1 ? raw.length : endIdx + 'END:VCARD'.length;
    const proposals: FieldProposal[] = [];

    for (const { text, start } of splitLines(raw.slice(cardStart, cardEnd))) {
      const colon = text.indexOf(':');
      if (colon === -1) continue;
      const rawKey = text.slice(0, colon);
      // TEL;TYPE=CELL:... — the base property is before the first ';'.
      const baseKey = rawKey.split(';')[0].trim().toUpperCase();
      const field = VCARD_FIELD_MAP[baseKey];
      if (!field) continue;

      const rawValue = text.slice(colon + 1);
      const value = rawValue.trim();
      if (!value) continue;

      const valueStartInCard = start + colon + 1 + (rawValue.length - rawValue.trimStart().length);
      const absStart = cardStart + valueStartInCard;

      const typeMatch = /TYPE=([A-Za-z]+)/i.exec(rawKey);
      proposals.push({
        field,
        // ORG:Acme;Sales — the unit after ';' is a sub-org, so keep the first component.
        value: field === 'organization' ? value.split(';')[0].trim() : value,
        confidence: 0.98,
        evidence: span(
          raw,
          absStart,
          field === 'organization' ? value.split(';')[0].trim().length : value.length,
        ),
        origin: 'local',
        ...(typeMatch ? { qualifier: typeMatch[1].toLowerCase() } : {}),
      });
    }

    candidates.push({ index, proposals });
    index += 1;
    beginRe.lastIndex = cardEnd;
  }
  return candidates;
}

export const vcardBackend: ContactBackend = {
  kind: 'VCARD',
  // A single-card surface handed a multi-card file still returns them all rather than
  // silently discarding the rest — dropping contacts is the failure mode to avoid.
  extract: ({ raw }) => (parseVCards(raw).length ? parseVCards(raw) : [{ index: 0, proposals: [] }]),
};

export const vcardMultiBackend: ContactBackend = {
  kind: 'VCARD_MULTI',
  extract: ({ raw }) => parseVCards(raw),
};

// ---------------------------------------------------------------------------
// Mobile contact picker
// ---------------------------------------------------------------------------

interface MobileContactShape {
  name?: string;
  displayName?: string;
  emails?: Array<string | { value?: string; label?: string }>;
  phones?: Array<string | { value?: string; label?: string }>;
  organization?: string;
  jobTitle?: string;
}

/**
 * The OS contact picker hands over structured records, so there is nothing to guess. The
 * catch is that `raw` must still contain the text the spans index into — the orchestrator
 * serialises the payload to JSON and passes THAT as raw, so evidence stays verifiable by
 * the same guard as every other surface rather than needing an exemption.
 */
export const mobileContactsBackend: ContactBackend = {
  kind: 'MOBILE_CONTACTS',
  extract: ({ raw, structured }) => {
    const list: MobileContactShape[] = Array.isArray(structured)
      ? (structured as MobileContactShape[])
      : structured
        ? [structured as MobileContactShape]
        : [];

    return list.map((c, index) => {
      const proposals: FieldProposal[] = [];
      const push = (field: string, value: unknown, confidence: number, qualifier?: string) => {
        if (typeof value !== 'string' || !value.trim()) return;
        const v = value.trim();
        const at = raw.indexOf(v);
        if (at === -1) return; // unverifiable → the guard would drop it anyway
        proposals.push({
          field,
          value: v,
          confidence,
          evidence: span(raw, at, v.length),
          origin: 'local',
          ...(qualifier ? { qualifier } : {}),
        });
      };

      push('full_name', c.name ?? c.displayName, 0.97);
      push('organization', c.organization, 0.95);
      push('job_title', c.jobTitle, 0.9);
      for (const e of c.emails ?? []) {
        const val = typeof e === 'string' ? e : e?.value;
        const lbl = typeof e === 'string' ? undefined : e?.label;
        push('email', val, 0.97, lbl);
      }
      for (const p of c.phones ?? []) {
        const val = typeof p === 'string' ? p : p?.value;
        const lbl = typeof p === 'string' ? undefined : p?.label;
        push('phone', val, 0.97, lbl);
      }
      return { index, proposals };
    });
  },
};

// ---------------------------------------------------------------------------
// Voice transcript
// ---------------------------------------------------------------------------

/**
 * Spoken contact details. A transcript says "john at example dot com", so the literal
 * characters of the address are not present and a naive matcher finds nothing.
 *
 * The de-spoken form is reconstructed, but the evidence span points at the ORIGINAL
 * spoken characters. The fabrication guard understands the same substitutions, so the
 * claim stays checkable — the value is derived by a rule anyone can replay, not invented.
 * Confidence is capped well below typed input because transcription itself is lossy.
 */
const SPOKEN_REPLACEMENTS: Array<[RegExp, string]> = [
  [/\s+at\s+/gi, '@'],
  [/\s+dot\s+/gi, '.'],
  [/\s+underscore\s+/gi, '_'],
  [/\s+dash\s+/gi, '-'],
  [/\s+hyphen\s+/gi, '-'],
];

export function despeak(text: string): string {
  let out = text;
  for (const [re, to] of SPOKEN_REPLACEMENTS) out = out.replace(re, to);
  return out;
}

export const voiceTranscriptBackend: ContactBackend = {
  kind: 'VOICE_TRANSCRIPT',
  extract: ({ raw }) => {
    const proposals: FieldProposal[] = [];

    // Scan windows of the transcript, de-speaking each, so a reconstructed address can be
    // tied back to the exact spoken characters that produced it.
    for (const { text, start } of splitLines(raw)) {
      const spoken = despeak(text);
      for (const m of matchAll(spoken, EMAIL_RE)) {
        // Map back: find the spoken run that yielded this address.
        const before = spoken.slice(0, m.index);
        const approxStart = approximateOriginalOffset(text, before.length);
        const approxEnd = approximateOriginalOffset(text, before.length + m.text.length);
        proposals.push({
          field: 'email',
          value: m.text,
          confidence: 0.6,
          evidence: span(raw, start + approxStart, Math.max(1, approxEnd - approxStart)),
          origin: 'local',
          qualifier: 'transcribed',
        });
      }
    }

    // Digits are spoken as digits often enough that the ordinary phone matcher applies.
    for (const p of phoneProposals(raw)) {
      proposals.push({ ...p, confidence: 0.5, qualifier: 'transcribed' });
    }

    const names = nameProposals(raw, proposals);
    return [{ index: 0, proposals: [...names.map((n) => ({ ...n, confidence: 0.4 })), ...proposals] }];
  },
};

/**
 * Map an offset in the de-spoken string back to the original. The substitutions only ever
 * SHRINK the text, so scanning forward while re-applying them is exact enough to give a
 * reviewer the right region — and the guard re-derives rather than trusting this.
 */
function approximateOriginalOffset(original: string, despokenOffset: number): number {
  let o = 0;
  let d = 0;
  while (d < despokenOffset && o < original.length) {
    const rest = original.slice(o);
    const hit = SPOKEN_REPLACEMENTS.find(([re]) => {
      const r = new RegExp(`^(?:${re.source})`, re.flags.replace('g', ''));
      return r.test(rest);
    });
    if (hit) {
      const r = new RegExp(`^(?:${hit[0].source})`, hit[0].flags.replace('g', ''));
      const matched = r.exec(rest)![0];
      o += matched.length;
      d += hit[1].length;
    } else {
      o += 1;
      d += 1;
    }
  }
  return o;
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

const REGISTRY = new Map<ContactSourceKind, ContactBackend>([
  ['SMART_PASTE', smartPasteBackend],
  ['EMAIL_SIGNATURE', emailSignatureBackend],
  ['BUSINESS_CARD_OCR', businessCardBackend],
  ['VCARD', vcardBackend],
  ['VCARD_MULTI', vcardMultiBackend],
  ['MOBILE_CONTACTS', mobileContactsBackend],
  ['BROWSER_SELECTION', browserSelectionBackend],
  ['VOICE_TRANSCRIPT', voiceTranscriptBackend],
]);

export function getContactBackend(kind: ContactSourceKind): ContactBackend {
  const b = REGISTRY.get(kind);
  if (!b) {
    throw new Error(
      `[sdk-parsing] no contact backend registered for source kind '${kind}' — ` +
        `known kinds: ${CONTACT_SOURCE_KINDS.join(', ')}`,
    );
  }
  return b;
}

/** Register or override a backend (a vertical may ship a better card reader). */
export function setContactBackend(kind: ContactSourceKind, backend: ContactBackend): void {
  REGISTRY.set(kind, backend);
}

export function listContactBackends(): ContactSourceKind[] {
  return [...REGISTRY.keys()];
}
