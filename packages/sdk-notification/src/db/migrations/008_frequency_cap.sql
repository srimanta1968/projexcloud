-- Migration 008: frequency caps and the no-answer dedup window (P16 · EP-383).
--
-- ADDITIVE ONLY. Nothing here alters an existing table, so every current notification
-- endpoint keeps its behaviour: a caller that does not supply a purpose or a dedup key
-- takes exactly the path it took before.
--
-- Two separate problems, deliberately not merged into one table:
--
--   * A CAP is a rate: "at most N automated sends on this channel, for this purpose, per
--     day". It is answered by counting.
--   * A DEDUP WINDOW is an identity: "this exact send already happened recently, so the
--     retry is the same send, not a second one". It is answered by a unique key.
--
-- Counting cannot express dedup — two retries of the same message are two rows and would
-- consume two units of the cap while still both being delivered. A unique key cannot
-- express a cap. Conflating them produces a system that is wrong in one direction or the
-- other, so they are enforced by different mechanisms against the same ledger.

CREATE SCHEMA IF NOT EXISTS notification;

-- ---------------------------------------------------------------------------
-- notification.frequency_policy — tenant-configurable, per channel + purpose.
--
-- tenant_id NULL is the platform default, matching the pattern used elsewhere in the
-- platform: resolution is an ORDER BY rather than a join, and the default and an override
-- can never disagree about their shape.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS notification.frequency_policy (
  policy_id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id             UUID,
  /** '*' is the catch-all for channels/purposes with no specific policy. */
  channel               TEXT NOT NULL DEFAULT '*',
  purpose               TEXT NOT NULL DEFAULT '*',

  /** Max AUTOMATED sends per rolling day. NULL means uncapped, which is not the same as 0. */
  max_per_day           INTEGER CHECK (max_per_day IS NULL OR max_per_day >= 0),

  /*
   * How long an identical send is considered the SAME send. A retry inside this window is
   * suppressed rather than delivered again — the caller still gets a successful-looking
   * result, because from its point of view the message did go out.
   */
  dedup_window_seconds  INTEGER NOT NULL DEFAULT 900
                          CHECK (dedup_window_seconds >= 0 AND dedup_window_seconds <= 604800),

  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by            TEXT,

  CONSTRAINT notif_freq_channel_nonblank CHECK (length(btrim(channel)) > 0),
  CONSTRAINT notif_freq_purpose_nonblank CHECK (length(btrim(purpose)) > 0)
);

CREATE UNIQUE INDEX IF NOT EXISTS notif_freq_tenant_idx
  ON notification.frequency_policy (tenant_id, channel, purpose)
  WHERE tenant_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS notif_freq_platform_idx
  ON notification.frequency_policy (channel, purpose)
  WHERE tenant_id IS NULL;

-- The shipped default: uncapped, with a 15-minute dedup window. Uncapped on purpose —
-- turning caps on for every existing tenant during a migration would silently start
-- dropping their traffic, which is the one outcome an additive change must not cause.
INSERT INTO notification.frequency_policy (tenant_id, channel, purpose, max_per_day, dedup_window_seconds, updated_by)
SELECT NULL, '*', '*', NULL, 900, 'platform-default'
WHERE NOT EXISTS (
  SELECT 1 FROM notification.frequency_policy
   WHERE tenant_id IS NULL AND channel = '*' AND purpose = '*'
);

-- ---------------------------------------------------------------------------
-- notification.send_ledger — one row per accepted automated send.
--
-- Serves both mechanisms: COUNT(*) over the last day answers the cap, and the partial
-- unique index on dedup_key answers the window.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS notification.send_ledger (
  ledger_id      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      UUID NOT NULL,
  channel        TEXT NOT NULL,
  purpose        TEXT NOT NULL DEFAULT '*',
  destination    TEXT NOT NULL,

  /*
   * The identity of a send: normally hash(tenant, channel, purpose, destination, body).
   * Nullable because a caller that does not want dedup simply omits it, and a NULL never
   * collides in the partial unique index below.
   */
  dedup_key      TEXT,
  /** When this row stops blocking a retry. Kept explicit so the check is one indexed read. */
  dedup_until    TIMESTAMPTZ,

  outcome        TEXT NOT NULL DEFAULT 'sent'
                   CHECK (outcome IN ('sent', 'suppressed_dedup', 'suppressed_cap')),
  sent_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  metadata       JSONB NOT NULL DEFAULT '{}'::jsonb
);

-- THE DEDUP GUARANTEE. A partial unique index over rows still inside their window: an
-- INSERT ... ON CONFLICT DO NOTHING that inserts nothing IS the duplicate detection, so two
-- concurrent retries cannot both decide they are first. A read-then-write check would let
-- exactly that happen under the retry storm this exists to stop.
CREATE UNIQUE INDEX IF NOT EXISTS notif_send_dedup_idx
  ON notification.send_ledger (tenant_id, dedup_key)
  WHERE dedup_key IS NOT NULL AND outcome = 'sent';

-- The cap read: sends for this tenant/channel/purpose in the trailing window.
CREATE INDEX IF NOT EXISTS notif_send_cap_idx
  ON notification.send_ledger (tenant_id, channel, purpose, sent_at DESC)
  WHERE outcome = 'sent';

CREATE INDEX IF NOT EXISTS notif_send_expiry_idx
  ON notification.send_ledger (dedup_until)
  WHERE dedup_until IS NOT NULL;

COMMENT ON TABLE notification.frequency_policy IS
  'sdk-notification (P16 EP-383). Per channel+purpose caps; tenant_id NULL = platform default (uncapped).';
COMMENT ON TABLE notification.send_ledger IS
  'sdk-notification (P16 EP-383). Accepted automated sends; partial unique index enforces the dedup window.';
