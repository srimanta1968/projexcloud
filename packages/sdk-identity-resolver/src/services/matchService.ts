import crypto from 'crypto';
import { dataService } from '@projexlight/db-runtime';
import { CANDIDATE_MIN, createCandidateLink, probabilisticMatch, type CandidateLink } from './empiService';
import type { MatchableIdentity } from './fieldMatch';

/**
 * Trait resolution — "which person is this capture about?".
 *
 * WHY THIS EXISTS. `sdk-capability.json` has always advertised
 * `POST /api/resolver/resolve` as "resolve a signal bundle to the most-likely
 * persona; returns persona_id + confidence + matched fields". The route of that
 * name does something else entirely: it reads an identity CONTEXT for a
 * person_id the caller already knows. Nothing in the platform turned traits into
 * a match, and `matchAndLink` — the function that raises the POSSIBLY_SAME
 * candidate links a steward reviews — had no caller anywhere in the monorepo. So
 * `empi.candidate_link` could only ever be filled by hand, and every consumer
 * that built against the published description got a 400.
 *
 * THE TWO ANSWERS ARE DELIBERATELY ASYMMETRIC. A crosswalk hit links outright,
 * because it is a recorded fact: somebody already asserted that this identifier
 * belongs to this person. Anything else raises a candidate link and links
 * NOTHING, because a probabilistic match is a guess about which human this is,
 * and merging two people is far harder to undo than it was to make.
 */

/** The signal bundle a caller has in front of them. */
export interface ResolveTraitsInput {
  tenant_id: string;
  /** Application scope for a crosswalk lookup. Optional — aliases are global. */
  app_id?: string;
  /** The capture this bundle came from, carried into provenance for the steward. */
  source_record_id?: string;
  /**
   * The person the caller already believes this is. Supplied when re-resolving a
   * record that has been promoted; absent for a first resolution.
   */
  person_id?: string;
  traits: {
    name?: string;
    email?: string;
    phone?: string;
    dob?: string;
    address?: string;
    external_id?: string;
  };
}

export interface ResolveTraitsResult {
  /**
   * `exact_crosswalk` is the ONLY value a caller may auto-link on, and it is
   * returned only for a recorded identifier. `possibly_same` carries a case for
   * a human; `no_match` means nothing was close enough to be worth asking about.
   */
  match_type: 'exact_crosswalk' | 'possibly_same' | 'no_match';
  /** The matched or newly-registered person. Null when nothing matched. */
  person_id: string | null;
  /** The candidate link a steward will adjudicate. Null unless possibly_same. */
  case_id: string | null;
  /** Confidence of the best probabilistic match, null for the other two answers. */
  confidence: number | null;
  /** Every link raised by this call — one per candidate above the threshold. */
  candidate_links: CandidateLink[];
  /** How the answer was reached, in words a steward can read back. */
  explanation: string;
}

/** The alias hash convention, identical to sdk-identity's `hashValue`. */
function aliasHash(value: string): Buffer {
  return crypto.createHash('sha256').update(value.toLowerCase().trim()).digest();
}

/** Whether a person is known to this tenant at all. */
async function isMember(person_id: string, tenant_id: string): Promise<boolean> {
  const row = await dataService.one<{ one: number }>(
    `SELECT 1 AS one FROM identity.tenant_membership
      WHERE person_id = $1::uuid AND tenant_id = $2::uuid LIMIT 1`,
    [person_id, tenant_id],
  );
  return Boolean(row);
}

/**
 * A recorded identifier for this person, if one exists in this tenant.
 *
 * MEMBERSHIP IS CHECKED, NOT ASSUMED. `identity.alias` is unique on
 * (kind, value_hash) across the whole platform, so an email alias resolves to
 * one person globally. Returning that person to a tenant they have no
 * relationship with would confirm the person exists elsewhere — which is the
 * disclosure a crosswalk lookup must not make. A hit outside the tenant is
 * reported as no crosswalk, exactly as if the identifier were unknown.
 */
async function findCrosswalk(input: ResolveTraitsInput): Promise<string | null> {
  const { traits, tenant_id, app_id } = input;

  if (app_id && traits.external_id) {
    const row = await dataService.one<{ person_id: string }>(
      `SELECT person_id::text AS person_id FROM identity.app_identity
        WHERE app_id = $1 AND external_subject = $2 LIMIT 1`,
      [app_id, traits.external_id],
    );
    if (row && (await isMember(row.person_id, tenant_id))) return row.person_id;
  }

  for (const [kind, value] of [
    ['email', traits.email],
    ['phone', traits.phone],
  ] as const) {
    if (!value) continue;
    const row = await dataService.one<{ person_id: string }>(
      `SELECT person_id::text AS person_id FROM identity.alias
        WHERE kind = $1 AND value_hash = $2 AND merged_into_alias_id IS NULL LIMIT 1`,
      [kind, aliasHash(value)],
    );
    if (row && (await isMember(row.person_id, tenant_id))) return row.person_id;
  }

  return null;
}

/**
 * The people this tenant already holds, with the traits worth matching on.
 *
 * READ FROM `source_record`, NOT FROM `identity`. The identity schema stores
 * aliases as a hash and an encrypted envelope, which is right — it makes an
 * identifier checkable without making it readable — but it means the identity
 * tables cannot answer "is this name a bit like that name". The normalised
 * captures are where a tenant's plaintext traits legitimately live, and a
 * capture that carries a subject_ref is exactly a person this tenant already
 * knows. A tenant therefore matches against its OWN records and no one else's,
 * which the WHERE clause enforces rather than assumes.
 */
async function candidatesFor(tenant_id: string, exclude: string | null): Promise<MatchableIdentity[]> {
  const rows = await dataService.rows<{
    subject_ref: string;
    normalized: Record<string, unknown> | null;
  }>(
    `SELECT DISTINCT ON (subject_ref) subject_ref::text AS subject_ref, normalized
       FROM source_record.source_record
      WHERE tenant_id = $1::uuid
        AND subject_ref IS NOT NULL
        AND normalized IS NOT NULL
      ORDER BY subject_ref, created_at DESC
      LIMIT 500`,
    [tenant_id],
  );

  const str = (bag: Record<string, unknown>, ...keys: string[]): string | undefined => {
    for (const key of keys) {
      const value = bag[key];
      if (typeof value === 'string' && value.trim() !== '') return value;
    }
    return undefined;
  };

  return rows
    .filter((row) => row.subject_ref !== exclude)
    .map((row) => {
      const bag = (row.normalized ?? {}) as Record<string, unknown>;
      return {
        person_id: row.subject_ref,
        name: str(bag, 'full_name', 'name'),
        dob: str(bag, 'dob', 'date_of_birth'),
        address: str(bag, 'address', 'postal_address'),
        phone: str(bag, 'phone', 'phone_number', 'mobile'),
        external_ids: [str(bag, 'email')].filter((v): v is string => Boolean(v)),
      };
    });
}

/**
 * Register the incoming record as a person of its own.
 *
 * LINK-OVER-MERGE MEANS BOTH RECORDS SURVIVE, so a candidate link needs two
 * person ids by construction — there is nothing to adjudicate between a person
 * and a set of loose traits. The new row is `coexistence`: it asserts that this
 * capture is *a* person, never that it is a *different* person from the one it
 * is about to be linked to. If the steward verifies the link, both ids remain
 * and a merge event records the assertion; if they keep them separate, this row
 * was the right answer all along.
 *
 * ALIASES ARE WRITTEN FOR WHAT WE HAVE, so the NEXT capture carrying the same
 * email is a crosswalk hit rather than a second candidate case. Conflicts are
 * swallowed: the unique index is on (kind, value_hash) platform-wide, and losing
 * a race to another tenant's writer must not fail the resolution.
 */
async function registerPerson(input: ResolveTraitsInput): Promise<string> {
  const person = await dataService.one<{ person_id: string }>(
    `INSERT INTO identity.person (home_region, mdm_method)
     VALUES ('us-east-1', 'coexistence')
     RETURNING person_id::text AS person_id`,
  );
  if (!person) throw new Error('resolver: could not register a person for this capture');

  await dataService.query(
    `INSERT INTO identity.tenant_membership (person_id, tenant_id, status)
     VALUES ($1::uuid, $2::uuid, 'active')
     ON CONFLICT DO NOTHING`,
    [person.person_id, input.tenant_id],
  );

  for (const [kind, value] of [
    ['email', input.traits.email],
    ['phone', input.traits.phone],
  ] as const) {
    if (!value) continue;
    await dataService.query(
      `INSERT INTO identity.alias (person_id, kind, value_hash)
       VALUES ($1::uuid, $2, $3)
       ON CONFLICT DO NOTHING`,
      [person.person_id, kind, aliasHash(value)],
    );
  }

  return person.person_id;
}

/**
 * The evidence table behind one candidate link, field by field.
 *
 * BOTH SIDES ARE NAMED, INCLUDING THE ABSENT ONE. A field only one record holds
 * contributes nothing to the score, and saying so ("not supplied on the incoming
 * record") is different from omitting the row — the second reads as though the
 * field agreed. The steward is overruling a model that declined to decide, and
 * what it could not see is part of why.
 */
function featuresFor(
  subject: MatchableIdentity,
  candidate: MatchableIdentity | undefined,
  similarity: Record<string, number>,
): { feature: string; incoming: string | null; existing: string | null; assessment: string; weight: string }[] {
  const fields: [string, string | undefined, string | undefined][] = [
    ['name', subject.name, candidate?.name],
    ['email', subject.external_ids?.[0], candidate?.external_ids?.[0]],
    ['phone', subject.phone, candidate?.phone],
    ['dob', subject.dob, candidate?.dob],
    ['address', subject.address, candidate?.address],
  ];

  return fields
    .filter(([, incoming, existing]) => incoming || existing)
    .map(([feature, incoming, existing]) => {
      const score = similarity[feature] ?? similarity[`${feature}s`];
      let assessment: string;
      if (!incoming) assessment = 'not supplied on the incoming record';
      else if (!existing) assessment = 'not held on the canonical record';
      else if (score === undefined) assessment = 'not scored';
      else if (score >= 0.99) assessment = 'exact match';
      else if (score >= 0.8) assessment = 'near match';
      else if (score > 0) assessment = 'weak similarity';
      else assessment = 'no match';

      return {
        feature,
        incoming: incoming ?? null,
        existing: existing ?? null,
        assessment,
        weight: score === undefined ? '-' : score.toFixed(2),
      };
    });
}

/**
 * Resolve a signal bundle: crosswalk first, then probabilistic candidates.
 *
 * NOTHING IS WRITTEN WHEN NOTHING MATCHES. An unmatched capture does not get a
 * person here — promotion is a governed act with its own endpoint and its own
 * evidence requirements, and quietly registering a person for every inbound
 * trait bundle would populate the identity graph from unreviewed input.
 */
export async function resolveTraits(input: ResolveTraitsInput): Promise<ResolveTraitsResult> {
  if (!input.tenant_id) throw new Error('resolver: tenant_id is required');

  const crosswalk = await findCrosswalk(input);
  if (crosswalk) {
    return {
      match_type: 'exact_crosswalk',
      person_id: crosswalk,
      case_id: null,
      confidence: null,
      candidate_links: [],
      explanation: 'A recorded identifier already identifies this person, so the link is a fact rather than a judgement.',
    };
  }

  const subjectTraits: MatchableIdentity = {
    person_id: input.person_id,
    name: input.traits.name,
    dob: input.traits.dob,
    address: input.traits.address,
    phone: input.traits.phone,
    external_ids: input.traits.email ? [input.traits.email] : undefined,
  };

  const candidates = await candidatesFor(input.tenant_id, input.person_id ?? null);
  if (candidates.length === 0) {
    return {
      match_type: 'no_match',
      person_id: input.person_id ?? null,
      case_id: null,
      candidate_links: [],
      confidence: null,
      explanation: 'This tenant holds no linked records to compare against, so there is nothing this could be a duplicate of.',
    };
  }

  const matches = probabilisticMatch(subjectTraits, candidates, { threshold: CANDIDATE_MIN });

  if (matches.length === 0) {
    return {
      match_type: 'no_match',
      person_id: input.person_id ?? null,
      case_id: null,
      confidence: null,
      candidate_links: [],
      explanation: "Nothing held by this tenant scored close enough to be worth a steward's time.",
    };
  }

  // The subject needs an id before a link can name it. Registered only now —
  // after we know there is something worth adjudicating — so a capture that
  // matches nothing never creates an identity row on its own.
  const person_id = input.person_id ?? (await registerPerson(input));

  const links: CandidateLink[] = [];
  for (const match of matches) {
    const candidate = candidates.find((c) => c.person_id === match.person_id);
    links.push(
      await createCandidateLink(input.tenant_id, person_id, match.person_id, match.score, {
        matcher: 'fieldMatch.probabilistic',
        summary: `Possible same person at ${match.score.toFixed(2)}, below the bar for linking without a decision.`,
        // The SHAPE A STEWARD READS, not the raw similarity map. The screen
        // compares incoming against existing field by field, and a bare
        // {name: 0.82} tells them a number without telling them what was
        // compared — which is the one thing they need to overrule it.
        features: featuresFor(subjectTraits, candidate, match.provenance),
        source_record_id: input.source_record_id ?? null,
        raw_similarity: match.provenance,
      }),
    );
  }

  if (links.length === 0) {
    return {
      match_type: 'no_match',
      person_id,
      case_id: null,
      confidence: null,
      candidate_links: [],
      explanation: 'Nothing held by this tenant scored close enough to be worth a steward\'s time.',
    };
  }

  const best = links.reduce((a, b) => (Number(b.confidence) > Number(a.confidence) ? b : a));
  return {
    match_type: 'possibly_same',
    person_id,
    case_id: best.link_id,
    confidence: Number(best.confidence),
    candidate_links: links,
    explanation: `A possible match was found at ${Number(best.confidence).toFixed(2)} and needs a human decision before anything is linked.`,
  };
}
