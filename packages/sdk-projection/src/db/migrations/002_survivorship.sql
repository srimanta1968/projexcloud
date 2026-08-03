-- Migration 002: attribute survivorship and explained projection (P16 · EP-382).
--
-- 001 materialises ONE identity row per (person, app, tenant). This is a different
-- question: when several sources each assert a value for the same attribute — an import
-- says the phone is X, the customer typed Y, a rep verified Z — which one wins, and WHY?
--
-- The "why" is the reason this schema exists at all. A projection that returns only the
-- winner is unarguable: a user who believes the old number was right has nothing to point
-- at, and support cannot tell a bad import from correct precedence. So EVERY assertion is
-- retained and remains queryable; losing is a computed OUTCOME, not a deletion and not a
-- flag that overwrites the row.

CREATE SCHEMA IF NOT EXISTS projection;

-- ---------------------------------------------------------------------------
-- projection.attribute_assertion — one source's claim about one attribute.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS projection.attribute_assertion (
  assertion_id     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        UUID NOT NULL,

  /** `<kind>:<id>` — the subject this is about, in the platform's usual shape. */
  subject_ref      TEXT NOT NULL CHECK (length(btrim(subject_ref)) > 0),
  attribute        TEXT NOT NULL CHECK (length(btrim(attribute)) > 0),
  value            TEXT NOT NULL,

  /*
   * WHERE the claim came from, as a class rather than a system name. Rules rank classes,
   * so a tenant that swaps CRM vendors does not have to rewrite its precedence.
   */
  origin_class     TEXT NOT NULL,
  origin_ref       TEXT,

  confidence       NUMERIC(4,3) NOT NULL DEFAULT 1.000
                     CHECK (confidence >= 0 AND confidence <= 1),

  /*
   * Whether anyone CHECKED it. Distinct from confidence: a high-confidence parse of a
   * business card is still unverified, and those are different reasons to trust a value.
   */
  verification_state TEXT NOT NULL DEFAULT 'unverified'
                     CHECK (verification_state IN ('unverified', 'verified', 'rejected')),
  verified_at      TIMESTAMPTZ,

  /** When the SOURCE observed it — the recency signal. Not when we stored it. */
  observed_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  recorded_at      TIMESTAMPTZ NOT NULL DEFAULT now(),

  /*
   * Retraction is a state, never a DELETE. A retracted assertion still explains why the
   * projection looked the way it did last week, which is the whole point of keeping them.
   */
  retracted_at     TIMESTAMPTZ,
  superseded_by    UUID REFERENCES projection.attribute_assertion (assertion_id) ON DELETE SET NULL,

  metadata         JSONB NOT NULL DEFAULT '{}'::jsonb,

  CONSTRAINT proj_assertion_verified_shape CHECK (
    (verification_state = 'verified') = (verified_at IS NOT NULL)
  ),
  CONSTRAINT proj_assertion_not_self_superseded CHECK (
    superseded_by IS NULL OR superseded_by <> assertion_id
  )
);

CREATE INDEX IF NOT EXISTS proj_assertion_subject_idx
  ON projection.attribute_assertion (tenant_id, subject_ref, attribute, observed_at DESC);
CREATE INDEX IF NOT EXISTS proj_assertion_origin_idx
  ON projection.attribute_assertion (tenant_id, origin_class);
-- Losing assertions must stay cheap to query (AC3) — the live set is the common read.
CREATE INDEX IF NOT EXISTS proj_assertion_live_idx
  ON projection.attribute_assertion (tenant_id, subject_ref, attribute)
  WHERE retracted_at IS NULL;

-- ---------------------------------------------------------------------------
-- projection.survivorship_rule — the ordered precedence, per attribute.
--
-- tenant_id NULL is the PLATFORM DEFAULT. One table rather than two, so resolution is an
-- ORDER BY instead of a join, and so a tenant override and the default it replaces can
-- never disagree about their shape.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS projection.survivorship_rule (
  rule_set_id      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        UUID,
  /** '*' is the catch-all applied to attributes with no specific rule set. */
  attribute        TEXT NOT NULL DEFAULT '*',

  /*
   * The ordered criteria, e.g.
   *   [{"criterion":"verification_state","order":["verified","unverified","rejected"]},
   *    {"criterion":"origin_class","order":["human_verified","user_supplied","import"]},
   *    {"criterion":"confidence","direction":"desc"},
   *    {"criterion":"recency","direction":"desc"}]
   * Stored as an array because ORDER IS THE RULE — a set of weights could not express
   * "origin beats confidence" and would make ties unexplainable.
   */
  criteria         JSONB NOT NULL,

  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by       TEXT,

  CONSTRAINT proj_rule_criteria_is_array CHECK (jsonb_typeof(criteria) = 'array')
);

-- One rule set per (tenant, attribute). Two partial uniques because NULL tenant_id is the
-- platform row and NULLs do not compare equal in a plain UNIQUE.
CREATE UNIQUE INDEX IF NOT EXISTS proj_rule_tenant_attr_idx
  ON projection.survivorship_rule (tenant_id, attribute)
  WHERE tenant_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS proj_rule_platform_attr_idx
  ON projection.survivorship_rule (attribute)
  WHERE tenant_id IS NULL;

-- The shipped platform default. A tenant overrides it by writing its own row; it is never
-- edited in place, so "what does the platform say" stays answerable.
INSERT INTO projection.survivorship_rule (tenant_id, attribute, criteria, updated_by)
SELECT NULL, '*', '[
  {"criterion":"verification_state","order":["verified","unverified","rejected"]},
  {"criterion":"origin_class","order":["human_verified","user_supplied","enrichment","import","inferred"]},
  {"criterion":"confidence","direction":"desc"},
  {"criterion":"recency","direction":"desc"}
]'::jsonb, 'platform-default'
WHERE NOT EXISTS (
  SELECT 1 FROM projection.survivorship_rule WHERE tenant_id IS NULL AND attribute = '*'
);

COMMENT ON TABLE projection.attribute_assertion IS
  'sdk-projection (P16 EP-382). Every source claim, retained; losing is computed, never deleted.';
COMMENT ON TABLE projection.survivorship_rule IS
  'sdk-projection (P16 EP-382). Ordered precedence per attribute; tenant_id NULL = platform default.';
