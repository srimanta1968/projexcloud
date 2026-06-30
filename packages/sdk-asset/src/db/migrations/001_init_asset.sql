-- sdk-asset: digital-twin registry for physical-AI fleets.
-- A robot is an `asset` (linked to its device_uuid for enrollment/attestation),
-- composed of a self-referential `component` tree (torso -> arm -> hand ->
-- finger, leg, ...), and each component carries a `sensor` catalog. Additive
-- only; safe to re-run (IF NOT EXISTS).

CREATE SCHEMA IF NOT EXISTS asset;

CREATE TABLE IF NOT EXISTS asset.asset (
  asset_id      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL,
  bu_id         uuid,
  device_uuid   text,           -- links to device.device (enrollment + attestation)
  model         text,
  display_name  text,
  status        text NOT NULL DEFAULT 'active',
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS asset_asset_tenant_idx ON asset.asset (tenant_id);
CREATE INDEX IF NOT EXISTS asset_asset_device_idx ON asset.asset (device_uuid);

CREATE TABLE IF NOT EXISTS asset.component (
  component_id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  asset_id            uuid NOT NULL REFERENCES asset.asset(asset_id) ON DELETE CASCADE,
  parent_component_id uuid REFERENCES asset.component(component_id) ON DELETE CASCADE,
  kind                text NOT NULL,   -- torso, head, arm, hand, finger, leg, ...
  name                text,
  position            jsonb,
  created_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS asset_component_asset_idx ON asset.component (asset_id);
CREATE INDEX IF NOT EXISTS asset_component_parent_idx ON asset.component (parent_component_id);

CREATE TABLE IF NOT EXISTS asset.sensor (
  sensor_id      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  component_id   uuid NOT NULL REFERENCES asset.component(component_id) ON DELETE CASCADE,
  asset_id       uuid NOT NULL REFERENCES asset.asset(asset_id) ON DELETE CASCADE,
  kind           text NOT NULL,   -- force, temperature, joint_angle, camera, ...
  unit           text,
  min_value      double precision,
  max_value      double precision,
  sample_rate_hz double precision,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS asset_sensor_component_idx ON asset.sensor (component_id);
CREATE INDEX IF NOT EXISTS asset_sensor_asset_idx ON asset.sensor (asset_id);
