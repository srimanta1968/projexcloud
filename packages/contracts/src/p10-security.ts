/**
 * P10 security & governance contracts — types shared between sdk-policy,
 * api-gateway, sdk-consent, sdk-vault, sdk-approval, sdk-identity-resolver and
 * every data-reading SDK.
 *
 * Source: Architecture v3.2 §11A.3–§11A.8 (P16/P17/P18, OC-11/OC-12) and the
 * P10 epic set (E1 Obligations · E2 Principal Token · E3 Consent-Gating ·
 * E4 Fail-Closed/Break-Glass · E9 Context Enrichment).
 *
 * DESIGN INVARIANT (E7 / non-breaking): EVERY field added here is optional and
 * additive. Absent values MUST preserve pre-P10 behaviour exactly, so existing
 * allow/deny-only and header-trusting consumers compile and behave unchanged.
 *
 * Contracts-first per Architecture v3.1 §0 and OC-2 (event registry).
 */

/* ============================================================
 * E1 · Obligation-based authorization (Architecture v3.2 §11A.3 · P16 · OC-11)
 * ============================================================ */

/**
 * Audit verbosity an obligation can demand for accesses made under a decision.
 * `standard` is the implicit level when an obligation omits `audit_level`.
 */
export type ObligationAuditLevel = 'none' | 'standard' | 'detailed' | 'forensic';

/**
 * Obligations returned alongside an ALLOW/DENY policy decision. They are
 * enforced SERVER-SIDE: the gateway and data-reading SDKs apply `mask_fields`
 * and `row_filter` before serialization, so UI-level visibility becomes
 * advisory only (closes the field-leak risk, critique Scenario 7).
 *
 * Entirely optional — a decision without obligations is exactly today's
 * allow/deny result.
 */
export interface Obligations {
  /**
   * Dot-path field names to redact from each result row before serialization
   * (e.g. `["ssn", "patient.dob"]`). Masked fields are replaced, never sent raw.
   */
  mask_fields?: string[];
  /**
   * Equality predicate injected into the read so only matching rows are
   * returned (e.g. `{ tenant_id: "...", bu_id: "..." }`). Enforced even when a
   * caller forgets to apply it.
   */
  row_filter?: Record<string, unknown>;
  /** Audit verbosity demanded for accesses made under this decision. */
  audit_level?: ObligationAuditLevel;
  /**
   * How long (seconds) a cached decision carrying these obligations may be
   * reused. Bounds the low-risk fail-closed cache (E4) and decision caching.
   */
  ttl_seconds?: number;
}

/* ============================================================
 * E2 · Platform principal token (Architecture v3.2 §11A.4 · P17)
 * ============================================================ */

/**
 * Claims carried by the minted, audience-bound platform principal token. The
 * gateway mints this from the SERVER-RESOLVED IdentityContext after auth;
 * downstream services verify it (iss/aud/exp/signature) instead of trusting
 * forwarded user headers — closing the confused-deputy class (critique
 * Scenario 5). Every claim derives only from verified identity, never request
 * input.
 */
export interface PrincipalTokenClaims {
  /** Issuer — the gateway. Verified downstream. */
  iss: string;
  /** Audience — the target service this token is bound to. Verified downstream. */
  aud: string;
  /** Subject — the resolved person_id. */
  sub: string;
  app_id: string;
  tenant_id: string;
  bu_id?: string | null;
  root_tenant_id?: string | null;
  /** all_persona_ids from the resolved context. */
  personas: string[];
  primary_persona_id?: string | null;
  /** effective_scopes from the resolved context. */
  scopes: string[];
  /** effective_role_closure from the resolved context. */
  roles?: string[];
  projection_version?: number;
  /** Actor kind (e.g. human/service/agent/support_impersonator) for break-glass + impersonation audit. */
  act?: { kind: string };
  /** Standard JWT timing/identity claims (populated by the signer). */
  iat?: number;
  exp?: number;
  jti?: string;
  /** Key id of the signing key — lets verifiers pick the right key during rotation overlap. */
  kid?: string;
}
