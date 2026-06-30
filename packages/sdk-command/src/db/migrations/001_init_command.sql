-- sdk-command: command & control plane for the physical-AI fleet (P12 · E1).
-- A command targets a robot (asset) or one of its components, carries typed
-- params, a risk_class that drives approval gating, and a status lifecycle that
-- spans issue -> (approval) -> dispatch -> ack. The ack from the robot/edge is
-- captured back onto the row (ack_at + ack_result). Additive only; safe to
-- re-run (IF NOT EXISTS). target_* are plain uuids (no cross-schema FK) so this
-- migration is order-independent of sdk-asset.

CREATE SCHEMA IF NOT EXISTS command;

CREATE TABLE IF NOT EXISTS command.command (
  command_id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           uuid NOT NULL,
  target_asset_id     uuid NOT NULL,
  target_component_id uuid,                              -- null => whole asset
  type                text NOT NULL,                     -- move, grip, stop, set_param, ...
  params              jsonb NOT NULL DEFAULT '{}'::jsonb,
  risk_class          text NOT NULL DEFAULT 'low',       -- low | medium | high | critical
  status              text NOT NULL DEFAULT 'pending',   -- pending | approved | rejected | dispatched | acked | failed | expired | cancelled
  approval_id         uuid,                              -- sdk-approval grant when risky
  issued_by           uuid NOT NULL,
  issued_at           timestamptz NOT NULL DEFAULT now(),
  dispatched_at       timestamptz,
  ack_at              timestamptz,
  ack_result          jsonb,                             -- { ok, code, message, ... } from the robot/edge
  updated_at          timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS command_command_tenant_idx ON command.command (tenant_id);
CREATE INDEX IF NOT EXISTS command_command_asset_idx  ON command.command (target_asset_id, issued_at DESC);
CREATE INDEX IF NOT EXISTS command_command_status_idx ON command.command (status, issued_at DESC);
