/**
 * Pluggable feature backends for sdk-lead-scoring (P7 FR-LSC-2).
 *
 * Each backend resolves one subscore for a contact:
 *
 *   - ProximityBackend → distance from contact's address to the
 *     tenant's nearest territory / depot. Production wires sdk-geo
 *     to read the canonical address_id. v1 default returns 0.5 when
 *     no caller-supplied location is provided so the scorer still
 *     produces a deterministic score during dev.
 *
 *   - ExpertiseBackend → fraction of the contact's persona kinds that
 *     match the tenant's vertical specialty list. v1 default is a
 *     simple list-membership check against caller-supplied skills.
 *
 *   - IntentBackend → recency-weighted engagement signal (last_visit_at,
 *     emails opened, replies). v1 default reads counts the caller
 *     supplies and applies a logarithmic dampening.
 *
 *   - StormImpactBackend → fraction of the contact's address polygons
 *     overlapping recent storm.event footprints. v1 default returns
 *     1.0 if caller passes hits>0 else 0.0; production wires sdk-storm
 *     for the bbox intersection.
 *
 * Every backend returns a number in [0, 1]; the scoring engine
 * weights each via lead_scoring.feature_weight rows and sums to a
 * 0–100 composite score.
 */

export interface ProximityInput {
  /** Distance in km from contact to nearest tenant location. */
  distance_km?: number | null;
  /** Caller-supplied subscore override (skip the backend). */
  override?: number;
}

export interface ExpertiseInput {
  /** Contact persona kinds (e.g. ['homeowner','insurance-claimant']). */
  persona_kinds?: string[];
  /** Tenant vertical specialties (e.g. ['roof','flood']). */
  vertical_specialties?: string[];
  override?: number;
}

export interface IntentInput {
  days_since_last_engagement?: number | null;
  emails_opened?: number;
  replies?: number;
  override?: number;
}

export interface StormImpactInput {
  /** Number of recent storm events whose footprint overlaps contact address. */
  overlapping_storm_events?: number;
  override?: number;
}

export interface ProximityBackend {
  score(input: ProximityInput): Promise<number>;
}
export interface ExpertiseBackend {
  score(input: ExpertiseInput): Promise<number>;
}
export interface IntentBackend {
  score(input: IntentInput): Promise<number>;
}
export interface StormImpactBackend {
  score(input: StormImpactInput): Promise<number>;
}

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(1, n));
}

/**
 * Distance-decay default. Score = 1 / (1 + distance_km / DECAY).
 * 0 km → 1.0; 25 km → 0.5; 100 km → 0.2. DECAY tunes per-vertical
 * via FieldOps territory radii.
 */
export class DistanceDecayProximity implements ProximityBackend {
  constructor(private readonly decay_km = 25) {}
  async score(input: ProximityInput): Promise<number> {
    if (input.override != null) return clamp01(input.override);
    if (input.distance_km == null) return 0.5;
    return clamp01(1 / (1 + Math.max(0, input.distance_km) / this.decay_km));
  }
}

/** Set-membership default: |kinds ∩ specialties| / |specialties|. */
export class SetMembershipExpertise implements ExpertiseBackend {
  async score(input: ExpertiseInput): Promise<number> {
    if (input.override != null) return clamp01(input.override);
    const specs = input.vertical_specialties ?? [];
    if (specs.length === 0) return 0.5;
    const kinds = new Set(input.persona_kinds ?? []);
    let hits = 0;
    for (const s of specs) if (kinds.has(s)) hits += 1;
    return clamp01(hits / specs.length);
  }
}

/**
 * Recency-weighted intent default. days_since_last_engagement decays
 * exponentially; emails_opened + 2×replies add a saturating boost.
 */
export class RecencyIntent implements IntentBackend {
  constructor(private readonly half_life_days = 14) {}
  async score(input: IntentInput): Promise<number> {
    if (input.override != null) return clamp01(input.override);
    const recency = input.days_since_last_engagement == null
      ? 0
      : Math.pow(0.5, input.days_since_last_engagement / this.half_life_days);
    const engagement = Math.log1p((input.emails_opened ?? 0) + 2 * (input.replies ?? 0)) / Math.log(10);
    return clamp01(0.5 * recency + 0.5 * Math.min(engagement, 1));
  }
}

/**
 * Storm-impact default: hits>0 → 1, otherwise 0. Production swaps in
 * a bbox-intersection backend that reads sdk-storm.intensity_cell.
 */
export class ThresholdStormImpact implements StormImpactBackend {
  async score(input: StormImpactInput): Promise<number> {
    if (input.override != null) return clamp01(input.override);
    return (input.overlapping_storm_events ?? 0) > 0 ? 1.0 : 0.0;
  }
}

/* ============================================================
 * Singleton registry — production swaps via setters.
 * ============================================================ */

let _proximity: ProximityBackend = new DistanceDecayProximity();
let _expertise: ExpertiseBackend = new SetMembershipExpertise();
let _intent: IntentBackend = new RecencyIntent();
let _storm: StormImpactBackend = new ThresholdStormImpact();

export function setProximityBackend(b: ProximityBackend): void { _proximity = b; }
export function setExpertiseBackend(b: ExpertiseBackend): void { _expertise = b; }
export function setIntentBackend(b: IntentBackend): void { _intent = b; }
export function setStormImpactBackend(b: StormImpactBackend): void { _storm = b; }

export function getProximityBackend(): ProximityBackend { return _proximity; }
export function getExpertiseBackend(): ExpertiseBackend { return _expertise; }
export function getIntentBackend(): IntentBackend { return _intent; }
export function getStormImpactBackend(): StormImpactBackend { return _storm; }

export function _resetLeadScoringBackends(): void {
  _proximity = new DistanceDecayProximity();
  _expertise = new SetMembershipExpertise();
  _intent = new RecencyIntent();
  _storm = new ThresholdStormImpact();
}
