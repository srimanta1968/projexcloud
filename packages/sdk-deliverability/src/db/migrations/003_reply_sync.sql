-- Migration 003: sdk-deliverability — IMAP inbound reply sync.
-- P14 · E3 (TK-3626). Auto-applied at boot. Additive + idempotent.
--
-- A per-tenant mailbox config the reply worker polls over IMAP, plus a reply_event
-- table capturing each inbound reply (thread-matched via In-Reply-To / References).
-- A human reply emits an event that pauses the subject's active sequence (pause-on-reply).

CREATE TABLE IF NOT EXISTS deliverability.mailbox (
  mailbox_id      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       UUID NOT NULL,
  host_persona_id UUID,
  imap_host       TEXT NOT NULL,
  imap_port       INTEGER NOT NULL DEFAULT 993 CHECK (imap_port > 0),
  username        TEXT NOT NULL,
  -- Vault ref for the IMAP password/OAuth token (never the raw secret).
  secret_ref      TEXT,
  folder          TEXT NOT NULL DEFAULT 'INBOX',
  use_tls         BOOLEAN NOT NULL DEFAULT true,
  -- IMAP UIDVALIDITY + last-seen UID cursor for incremental polling.
  uid_validity    BIGINT,
  last_uid        BIGINT NOT NULL DEFAULT 0,
  status          TEXT NOT NULL DEFAULT 'active'
                    CHECK (status IN ('active','paused','error')),
  last_synced_at  TIMESTAMPTZ,
  last_error      TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, username, folder)
);

CREATE INDEX IF NOT EXISTS deliverability_mailbox_tenant_idx
  ON deliverability.mailbox (tenant_id) WHERE status = 'active';

-- Captured inbound reply. message_id is unique per mailbox so re-polling is idempotent.
CREATE TABLE IF NOT EXISTS deliverability.reply_event (
  reply_event_id   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        UUID NOT NULL,
  mailbox_id       UUID REFERENCES deliverability.mailbox(mailbox_id) ON DELETE SET NULL,
  from_address_hash TEXT,
  subject_persona_id UUID,
  message_id       TEXT,
  in_reply_to      TEXT,
  references_ids   TEXT,
  subject          TEXT,
  snippet          TEXT,
  classification   TEXT NOT NULL DEFAULT 'human'
                     CHECK (classification IN ('human','auto_reply','ooo','bounce','other')),
  -- The sequence enrollment this reply matched (for pause-on-reply), if resolved.
  matched_enrollment_id UUID,
  paused_sequence  BOOLEAN NOT NULL DEFAULT false,
  imap_uid         BIGINT,
  received_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (mailbox_id, message_id)
);

CREATE INDEX IF NOT EXISTS deliverability_reply_event_tenant_idx
  ON deliverability.reply_event (tenant_id, received_at);
CREATE INDEX IF NOT EXISTS deliverability_reply_event_inreplyto_idx
  ON deliverability.reply_event (in_reply_to) WHERE in_reply_to IS NOT NULL;

COMMENT ON TABLE deliverability.mailbox IS 'Per-tenant IMAP mailbox config the reply worker polls (incremental via last_uid).';
COMMENT ON TABLE deliverability.reply_event IS 'Captured inbound reply (thread-matched via In-Reply-To/References). Human replies pause the sequence.';
