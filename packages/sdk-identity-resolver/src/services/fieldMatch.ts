/**
 * P10/E6 — probabilistic field matcher for EMPI. Pure + dependency-free.
 * Scores a candidate pair over name/DOB/address/phone/external-ID with
 * configurable weights; the deterministic resolver path is unaffected.
 */

export interface MatchableIdentity {
  person_id?: string;
  name?: string;
  dob?: string;
  address?: string;
  phone?: string;
  external_ids?: string[];
}

export interface MatchWeights {
  name: number;
  dob: number;
  address: number;
  phone: number;
  external_id: number;
}

/** Default field weights (sum need not be 1 — the score is normalized). */
export const DEFAULT_WEIGHTS: MatchWeights = {
  name: 0.35,
  dob: 0.25,
  address: 0.15,
  phone: 0.15,
  external_id: 0.1,
};

export interface MatchResult {
  /** Overall confidence 0..1 (weighted mean of contributing fields). */
  score: number;
  /** Per-field similarity contributing to the score (provenance). */
  provenance: Record<string, number>;
}

function normalize(s: string): string {
  return s.trim().toLowerCase().replace(/\s+/g, ' ');
}

/** Levenshtein distance between two strings. */
function levenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  let prev = Array.from({ length: n + 1 }, (_, i) => i);
  let curr = new Array<number>(n + 1).fill(0);
  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(curr[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
    }
    [prev, curr] = [curr, prev];
  }
  return prev[n];
}

/** Normalized string similarity in [0,1] (1 = identical). */
function similarity(a: string, b: string): number {
  const x = normalize(a);
  const y = normalize(b);
  if (x === y) return 1;
  const maxLen = Math.max(x.length, y.length);
  if (maxLen === 0) return 1;
  return 1 - levenshtein(x, y) / maxLen;
}

function lastDigits(phone: string, n = 7): string {
  return phone.replace(/\D/g, '').slice(-n);
}

/**
 * Scores a candidate pair. Only fields present on BOTH sides contribute; the
 * score is the weighted mean over those fields, so a pair sharing just a strong
 * external ID still scores high.
 */
export function scoreMatch(
  a: MatchableIdentity,
  b: MatchableIdentity,
  weights: MatchWeights = DEFAULT_WEIGHTS,
): MatchResult {
  const provenance: Record<string, number> = {};
  let weighted = 0;
  let totalWeight = 0;

  if (a.name && b.name) {
    const s = similarity(a.name, b.name);
    provenance.name = s;
    weighted += s * weights.name;
    totalWeight += weights.name;
  }
  if (a.dob && b.dob) {
    const s = normalize(a.dob) === normalize(b.dob) ? 1 : 0;
    provenance.dob = s;
    weighted += s * weights.dob;
    totalWeight += weights.dob;
  }
  if (a.address && b.address) {
    const s = similarity(a.address, b.address);
    provenance.address = s;
    weighted += s * weights.address;
    totalWeight += weights.address;
  }
  if (a.phone && b.phone) {
    const pa = lastDigits(a.phone);
    const pb = lastDigits(b.phone);
    const s = pa.length > 0 && pa === pb ? 1 : 0;
    provenance.phone = s;
    weighted += s * weights.phone;
    totalWeight += weights.phone;
  }
  if (a.external_ids?.length && b.external_ids?.length) {
    const setB = new Set(b.external_ids);
    const s = a.external_ids.some((id) => setB.has(id)) ? 1 : 0;
    provenance.external_id = s;
    weighted += s * weights.external_id;
    totalWeight += weights.external_id;
  }

  const score = totalWeight > 0 ? weighted / totalWeight : 0;
  return { score: Math.round(score * 10000) / 10000, provenance };
}
