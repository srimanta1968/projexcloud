-- Migration 001: sdk-event per P5 DataModel §8. Auto-applied via api-gateway.

CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE SCHEMA IF NOT EXISTS event;

CREATE TABLE IF NOT EXISTS event.session (
  session_id     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      UUID NOT NULL,
  encounter_id   UUID NOT NULL,
  title          TEXT NOT NULL,
  address_id     UUID,
  capacity       INT NOT NULL DEFAULT 0,
  sold_count     INT NOT NULL DEFAULT 0,
  starts_at      TIMESTAMPTZ NOT NULL,
  ends_at        TIMESTAMPTZ NOT NULL,
  status         TEXT NOT NULL DEFAULT 'scheduled'
                   CHECK (status IN ('scheduled','live','completed','cancelled')),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (ends_at > starts_at),
  CHECK (sold_count <= capacity)
);

CREATE INDEX IF NOT EXISTS event_session_tenant_idx ON event.session (tenant_id, status);

CREATE TABLE IF NOT EXISTS event.ticket (
  ticket_id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id          UUID NOT NULL REFERENCES event.session(session_id) ON DELETE CASCADE,
  holder_persona_id   UUID NOT NULL,
  price               NUMERIC(18,4),
  status              TEXT NOT NULL DEFAULT 'issued'
                        CHECK (status IN ('issued','used','refunded','void')),
  qr_token            TEXT NOT NULL UNIQUE,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS event_ticket_session_idx ON event.ticket (session_id, status);

CREATE TABLE IF NOT EXISTS event.checkin (
  checkin_id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ticket_id                 UUID NOT NULL UNIQUE REFERENCES event.ticket(ticket_id) ON DELETE RESTRICT,
  device_uuid               TEXT,
  checked_in_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  checked_in_by_persona_id  UUID NOT NULL
);

COMMENT ON TABLE event.session IS 'Event session as encounter.kind=session. Capacity-enforced sold_count.';
COMMENT ON TABLE event.ticket  IS 'Ticket with unique qr_token. Issued tickets transition to used via check-in.';
COMMENT ON TABLE event.checkin IS 'One check-in per ticket (UNIQUE). Records device_uuid + checked_in_by.';
