import type { CatalogSdk } from './sdkCatalog';
import type { RetrievedSdk } from './retriever';

/**
 * Candidate resolution stage of Planner v2 (TK-3472 + dependency closure).
 *
 * Semantic retrieval alone under-covers cross-cutting concerns: a user who
 * types "a financial accounting system" never says "login", so the auth/AIM
 * foundation is nowhere near the intent in embedding space and silently drops.
 * Two deterministic resolvers run between retrieve and compose:
 *
 *   1. injectFoundation  — always add the identity baseline (SDKs tagged
 *      tier='foundation' that form the auth/AIM stack), regardless of score,
 *      for any multi-user app.
 *   2. expandDependencies — for each selected domain SDK, walk the manifest
 *      consumes→provides event graph to pull its prerequisites (e.g. billing
 *      consumes tenant.created.v1 → sdk-tenant is dragged in).
 *
 * Both are pure functions over the catalog; no model, no network.
 */

export type CandidateSource = 'retrieval' | 'foundation' | 'dependency';

export interface Candidate {
  sdk: CatalogSdk;
  source: CandidateSource;
  /** Retrieval score when source === 'retrieval'. */
  score: number;
  /** Human-readable "why included" for foundation/dependency additions. */
  reason?: string;
}

/**
 * The auth/AIM baseline every multi-user app needs. These names are the
 * intended composition; injection is gated on the SDK actually existing in the
 * catalog AND carrying tier='foundation', so a renamed/removed SDK never forces
 * a phantom recommendation.
 */
const AUTH_BASELINE = [
  '@projexlight/sdk-identity', // login, JWT, MFA, SSO
  '@projexlight/sdk-persona',  // AIM: app-identities, memberships, roles, persona resolve
  '@projexlight/sdk-tenant',   // org/tenant/BU hierarchy + role templates
  '@projexlight/sdk-rebac',    // permission checks (who-can-do-what)
];

/** Heuristic: does the intent explicitly opt out of multi-user / auth? */
export function isSingleUserIntent(intent: string): boolean {
  return /\b(single[-\s]?user|no\s+login|without\s+(auth|login|accounts?)|anonymous|no\s+accounts?)\b/i.test(
    intent,
  );
}

/**
 * Seed the candidate set from retrieval hits, then inject the foundation tier
 * (unless the app is explicitly single-user/anonymous). Deduped by name —
 * a foundation SDK that retrieval already surfaced keeps its retrieval source.
 */
export function injectFoundation(
  intent: string,
  retrieved: RetrievedSdk[],
  catalog: CatalogSdk[],
): Candidate[] {
  const byName = new Map<string, Candidate>();

  for (const hit of retrieved) {
    byName.set(hit.sdk.name, { sdk: hit.sdk, source: 'retrieval', score: hit.score });
  }

  if (!isSingleUserIntent(intent)) {
    const catalogByName = new Map(catalog.map((s) => [s.name, s]));
    for (const name of AUTH_BASELINE) {
      const sdk = catalogByName.get(name);
      if (!sdk || sdk.tier !== 'foundation') continue; // only inject real foundation SDKs
      if (byName.has(name)) continue; // already retrieved — keep stronger source
      byName.set(name, {
        sdk,
        source: 'foundation',
        score: 0,
        reason: 'Foundation identity/AIM tier — every multi-user app needs login, personas, tenancy, and permission checks.',
      });
    }
  }

  return Array.from(byName.values());
}

/**
 * Dependency closure: for every candidate, find SDKs that PROVIDE an event the
 * candidate CONSUMES, and add the FOUNDATION-TIER ones as prerequisites.
 *
 * We deliberately restrict closure to foundation providers (identity, tenant,
 * vault, rebac, …). The event graph is dense — most domain SDKs consume common
 * platform events — so pulling in every provider explodes the candidate set
 * (a notes app would drag in CRM connectors). The reliable, on-narrative job of
 * closure is to surface the auth/tenancy/encryption BACKBONE a selected SDK
 * needs (e.g. billing consumes tenant.created.v1 → sdk-tenant). Domain↔domain
 * composition (billing↔payment) is left to retrieval + the compose LLM.
 *
 * Runs up to `maxDepth` passes so a prerequisite's own foundation prerequisites
 * are pulled in too. Existing candidates are never downgraded.
 */
export function expandDependencies(
  candidates: Candidate[],
  catalog: CatalogSdk[],
  maxDepth = 2,
): Candidate[] {
  // event name → FOUNDATION SDKs that provide it
  const foundationProvidersOf = new Map<string, CatalogSdk[]>();
  for (const sdk of catalog) {
    if (sdk.tier !== 'foundation') continue;
    for (const ev of sdk.providesEvents) {
      const list = foundationProvidersOf.get(ev) ?? [];
      list.push(sdk);
      foundationProvidersOf.set(ev, list);
    }
  }

  const byName = new Map<string, Candidate>();
  for (const c of candidates) byName.set(c.sdk.name, c);

  let frontier = [...candidates];
  for (let depth = 0; depth < maxDepth && frontier.length > 0; depth++) {
    const next: Candidate[] = [];
    for (const c of frontier) {
      for (const ev of c.sdk.consumesEvents) {
        for (const provider of foundationProvidersOf.get(ev) ?? []) {
          if (byName.has(provider.name)) continue; // already a candidate
          const added: Candidate = {
            sdk: provider,
            source: 'dependency',
            score: 0,
            reason: `Foundation prerequisite of ${shortName(c.sdk.name)} (provides ${ev}, which ${shortName(c.sdk.name)} consumes).`,
          };
          byName.set(provider.name, added);
          next.push(added);
        }
      }
    }
    frontier = next;
  }

  return Array.from(byName.values());
}

/**
 * Full resolution: retrieve → inject foundation → expand dependencies.
 * Returns candidates ordered foundation-first, then by retrieval score, then
 * dependency additions — a stable order the compose step renders.
 */
export function resolveCandidates(
  intent: string,
  retrieved: RetrievedSdk[],
  catalog: CatalogSdk[],
): Candidate[] {
  const withFoundation = injectFoundation(intent, retrieved, catalog);
  const withDeps = expandDependencies(withFoundation, catalog);

  const rank: Record<CandidateSource, number> = { foundation: 0, retrieval: 1, dependency: 2 };
  return withDeps.sort((a, b) => {
    if (rank[a.source] !== rank[b.source]) return rank[a.source] - rank[b.source];
    if (a.source === 'retrieval') return b.score - a.score;
    return a.sdk.name.localeCompare(b.sdk.name);
  });
}

function shortName(fullName: string): string {
  return fullName.replace('@projexlight/', '');
}
