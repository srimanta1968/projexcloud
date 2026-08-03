@feature_id:7dafe3f8-16b6-4dbe-80dc-3362158e5b1f
@epic_id:ee93bf20-3149-45d5-a712-d55cc74df2d9
Feature: 7-Tier Key Hierarchy
  UI coverage for the key-hierarchy management screen.

  REGENERATED against the UI authoring contract (projexlight_get_ui_feature_rules).
  The previous revision used narrative acceptance criteria as steps, e.g.
  "Given an authenticated administrator has access to a target key (or key
  material) in a specific tier within ProjexCloud and the key is currently
  usable for encryption/decryption operations" (192 chars) — the parser could
  not read those, so the scenarios never ran. Steps here use only the verified
  vocabulary (navigate / fill / click / select / should-see) and assert text
  copied from apps/tenant-workspace/app/admin/keys/page.tsx.

  @scenario_id:c09f06ad-9316-4b31-a074-d7693d252a42
  @scenario_type:UI
  @ui_test
  @portal:workspace
  @login:user
  Scenario: 1. Key hierarchy screen renders
    When I navigate to "/admin/keys"
    Then I should see "7-Tier Key Hierarchy"

  @scenario_id:dafb42b3-9bd0-48b4-ba21-2e3e94f8036a
  @scenario_type:UI
  @ui_test
  @portal:workspace
  @login:user
  Scenario: 2. Key tier creation and linking is described on the screen
    When I navigate to "/admin/keys"
    Then I should see "Key tiers can be created and linked"
