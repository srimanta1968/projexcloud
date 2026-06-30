@feature_id:c7f620e7-ab5f-4b6f-8632-4bb83ed44ed5
@epic_id:d386cc32-4151-4ae2-a337-a00891fc1d44
Feature: Physical-AI fleet end-to-end — twin → telemetry → control → ML export
  Walks the whole P12 · E1 journey for a robot: register its digital twin,
  ingest and query sensor telemetry, actuate it via the command plane (including
  an approval-gated risky command), and export a labeled, lineage-tracked
  training dataset — asserting authorization, audit and metering throughout.

  Background:
    Given a tenant workspace exists with an authorized session token
    And the gateway, ClickHouse rollups and command dispatcher are running

  @scenario_id:422c9eda-fd89-4955-a5df-77fd8c243049
  @scenario_type:API
  @api_test
  Scenario: 1. Twin → telemetry → control → labeled dataset export (happy path)
    # --- Twin ---
    When I POST "/api/assets" with a humanoid asset and a component/sensor tree
    Then the response status is 201 and I capture "asset_id"
    And GET "/api/assets/${asset_id}/twin" returns the nested asset → components → sensors
    # --- Telemetry ---
    When I POST "/api/ingest/sensor-readings/batch" with catalog-valid readings for the asset
    Then the response status is 201 and the readings are reported as imported
    And re-POSTing the same idempotency_key reports them as skipped (idempotent)
    And GET "/api/assets/${asset_id}/readings?bucket=minute" returns the rolled-up windows
    # --- Control ---
    When I mint a per-robot credential via POST "/api/assets/${asset_id}/credentials"
    Then the response status is 201 and I capture the plaintext "robot_key" (shown once)
    When I POST "/api/commands" issuing a low-risk "move" command for the asset
    Then the response status is 201, status is "approved", and I capture "command_id"
    And the dispatcher delivers the command and GET "/api/commands/${command_id}" becomes "dispatched"
    When the robot POSTs "/api/commands/${command_id}/ack" using the robot_key with ok=true
    Then the response status is 200 and the command status becomes "acked"
    # --- ML export ---
    When I POST "/api/analytics/datasets" defining a per-minute feature spec over the asset
    Then the response status is 201 and I capture "spec_id"
    When I PUT "/api/analytics/datasets/${spec_id}/label-source" with interval labels
    And I POST "/api/analytics/datasets/${spec_id}/build" over the ingest window
    Then the response status is 200 and I capture "build_id" with a non-zero row_count
    When I POST "/api/analytics/builds/${build_id}/export"
    Then the response status is 200 and an export_ref is returned

  @scenario_id:735d7c3f-a914-443a-a95f-e4c3ea9731f1
  @scenario_type:API
  @api_test
  Scenario: 2. A risky command is approval-gated; authZ and audit are enforced
    Given a registered asset for the tenant
    When I POST "/api/commands" issuing a high-risk "estop" command
    Then the response status is 201 and the command status is "pending" (awaiting approval)
    And the command is NOT delivered while pending
    When an authorized approver POSTs "/api/commands/${command_id}/decision" with approved=true
    Then the response status is 200 and the command status becomes "approved"
    And every transition (issued/gated/approved/dispatched/acked) is written to the audit ledger
    And an unauthorized issuer is denied with 403 and no command is persisted
    And a robot credential not scoped to the asset is denied at ack with 403

  @scenario_id:28d22edc-0e95-4116-b195-d1a123583cef
  @scenario_type:API
  @api_test
  Scenario: 3. Export is lineage-tracked, reproducible, and metered
    Given a built dataset for the asset with a recorded build_id
    When I GET "/api/analytics/datasets/${spec_id}/builds"
    Then each build carries a lineage_ref linking the dataset to its source asset
    And the build records its window so the dataset is reproducible
    When I GET "/api/meter/assets/${asset_id}/usage"
    Then per-sensor/per-robot usage is reported for the metered SKUs
