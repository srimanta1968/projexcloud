-- Migration 003: paid-social lead-form ingestion (P16 · EP-386).
--
-- One archive table for Meta / LinkedIn / TikTok / Google lead-form deliveries.
--
-- THE RAW PAYLOAD IS THE POINT. A lead form is the only record that the person actually
-- filled it in: the platform will not re-send it, and if normalisation rejects the row
-- (missing consent field, unmappable form version, a schema the provider changed without
-- telling anyone) then a system that stored only the normalised result has destroyed the
-- evidence AND the lead. So the raw JSON is written FIRST and kept regardless of what
-- happens afterwards; `outcome` records what the downstream did with it, and a rejected
-- row can be re-processed once the mapping is fixed.
--
-- IDEMPOTENCY IS A UNIQUE INDEX, not a lookup. These providers retry aggressively and
-- deliver the same event to several workers at once; a read-then-write check would let two
-- of them both decide they were first and create two leads from one form submission.

CREATE SCHEMA IF NOT EXISTS connectors;

CREATE TABLE IF NOT EXISTS connectors.lead_form_event (
  event_id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        UUID NOT NULL,

  platform         TEXT NOT NULL
                     CHECK (platform IN ('META', 'LINKEDIN', 'TIKTOK', 'GOOGLE')),
  /** The provider's OWN id for this delivery — the idempotency key. */
  source_event_id  TEXT NOT NULL CHECK (length(btrim(source_event_id)) > 0),

  /*
   * Queryable form of the payload, before any interpretation.
   *
   * NOTE jsonb REORDERS KEYS and drops duplicates — it stores a parsed value, not the
   * document. That is right for querying and wrong for evidence, which is why raw_body
   * below exists: an HMAC is over BYTES, so a payload archived only as jsonb could never
   * have its signature re-verified afterwards. Keeping both costs a little space and buys
   * the ability to prove, later, that the provider really sent this.
   */
  raw_payload      JSONB NOT NULL,
  /** The exact bytes the provider signed. Byte-for-byte, never re-serialised. */
  raw_body         TEXT,
  /** What the adapter made of it. NULL when normalisation failed. */
  normalized       JSONB,

  signature_verified BOOLEAN NOT NULL DEFAULT FALSE,

  /*
   * accepted    — normalised and handed downstream.
   * rejected    — normalisation or downstream validation refused it; raw is still here.
   * duplicate   — a replay of an event already recorded (see the unique index).
   */
  outcome          TEXT NOT NULL DEFAULT 'accepted'
                     CHECK (outcome IN ('accepted', 'rejected', 'duplicate')),
  rejection_reason TEXT,

  form_id          TEXT,
  campaign_id      TEXT,
  received_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  processed_at     TIMESTAMPTZ,

  CONSTRAINT lfe_rejection_shape CHECK (
    (outcome = 'rejected') = (rejection_reason IS NOT NULL)
  )
);

-- THE IDEMPOTENCY GUARANTEE. A replayed delivery collides here, so an
-- INSERT ... ON CONFLICT DO NOTHING that inserts nothing IS the replay detection —
-- correct even when two workers race, which a SELECT-then-INSERT is not.
CREATE UNIQUE INDEX IF NOT EXISTS lfe_platform_source_idx
  ON connectors.lead_form_event (tenant_id, platform, source_event_id);

CREATE INDEX IF NOT EXISTS lfe_tenant_recent_idx
  ON connectors.lead_form_event (tenant_id, received_at DESC);
-- The re-processing queue: rejected rows whose raw payload is still available to retry.
CREATE INDEX IF NOT EXISTS lfe_rejected_idx
  ON connectors.lead_form_event (tenant_id, received_at DESC)
  WHERE outcome = 'rejected';
CREATE INDEX IF NOT EXISTS lfe_campaign_idx
  ON connectors.lead_form_event (tenant_id, platform, campaign_id)
  WHERE campaign_id IS NOT NULL;

COMMENT ON TABLE connectors.lead_form_event IS
  'sdk-connectors (P16 EP-386). Raw-first archive; unique (tenant, platform, source_event_id) makes a replay a no-op.';
COMMENT ON COLUMN connectors.lead_form_event.raw_payload IS
  'Verbatim provider payload, retained even when outcome=rejected — the only record the lead ever existed.';
