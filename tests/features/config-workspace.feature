@feature_id:8e3514d6-1553-44f5-b219-af0065cf5ca0
@epic_id:26ace0ae-4cc6-4337-a315-761bbeb109d1
Feature: Workspace configuration and personal keys
  The tenant-workspace portal lets a signed-in end user tune per-app settings
  and manage their own personal keys from a single gated configuration page.

  @scenario_id:6b675c92-e0df-4fd2-8acd-0562d660114a
  @scenario_type:UI
  @ui_test
  @portal:workspace
  Scenario: 1. Configuration page shows app and personal sections
    Given I navigate to "/dashboard/config"
    Then I should see "App settings"
    And I should see "Your personal keys"
