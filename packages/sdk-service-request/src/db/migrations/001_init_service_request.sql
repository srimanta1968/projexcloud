-- Migration 001: sdk-service-request per P5 DataModel §7. Auto-applied via api-gateway.

CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE SCHEMA IF NOT EXISTS service_request;

CREATE TABLE IF NOT EXISTS service_request.queue (
  queue_id      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     UUID NOT NULL,
  name          TEXT NOT NULL,
  priority      INT NOT NULL DEFAULT 100,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, name)
);

CREATE TABLE IF NOT EXISTS service_request.routing_rule (
  rule_id      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  queue_id     UUID NOT NULL REFERENCES service_request.queue(queue_id) ON DELETE CASCADE,
  predicate    JSONB NOT NULL DEFAULT '{}'::jsonb,
  priority     INT NOT NULL DEFAULT 100,
  active       BOOLEAN NOT NULL DEFAULT TRUE
);

CREATE TABLE IF NOT EXISTS service_request.ticket (
  ticket_id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id              UUID NOT NULL,
  encounter_id           UUID NOT NULL,
  requester_persona_id   UUID NOT NULL,
  assignee_persona_id    UUID,
  queue_id               UUID REFERENCES service_request.queue(queue_id) ON DELETE SET NULL,
  priority               TEXT NOT NULL DEFAULT 'normal'
                           CHECK (priority IN ('low','normal','high','urgent')),
  severity               TEXT NOT NULL DEFAULT 'minor'
                           CHECK (severity IN ('trivial','minor','major','critical')),
  status                 TEXT NOT NULL DEFAULT 'new'
                           CHECK (status IN ('new','in-progress','awaiting-customer','resolved','closed')),
  sla_first_response_at  TIMESTAMPTZ,
  sla_resolution_at      TIMESTAMPTZ,
  first_responded_at     TIMESTAMPTZ,
  resolved_at            TIMESTAMPTZ,
  external_refs          JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS sr_ticket_tenant_idx    ON service_request.ticket (tenant_id, status);
CREATE INDEX IF NOT EXISTS sr_ticket_assignee_idx  ON service_request.ticket (assignee_persona_id) WHERE status NOT IN ('resolved','closed');
CREATE INDEX IF NOT EXISTS sr_ticket_encounter_idx ON service_request.ticket (encounter_id);
CREATE INDEX IF NOT EXISTS sr_ticket_sla_idx       ON service_request.ticket (sla_resolution_at) WHERE status NOT IN ('resolved','closed');

COMMENT ON TABLE service_request.ticket IS 'Ticket as encounter.kind=support. SLA timers + routing rules + bidirectional sync with Zendesk/Jira (via P5 connectors).';
