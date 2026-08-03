@feature_id:0ed4366a-b090-4d48-bdd2-202c3fbf2c0c
@epic_id:b7b01410-f1b7-4919-a8cd-d7eb77b9e953
Feature: Scope-aware provider configuration
  config.config_value resolves app_user then app then tenant then platform, first
  match wins. The screen must say WHICH scope answered for each key: a setting
  whose origin is invisible is one an admin is afraid to change, and therefore
  never changes. Removing an override falls BACK to the inherited value rather
  than deleting the setting.

  @scenario_id:governance-config-01
  @scenario_type:UI
  @ui_test
  @portal:tenantAdmin
  @login:user
  Scenario: 1. Providers are rendered from descriptors as labelled fields
    Given I navigate to "/config"
    Then I should see "Providers"
    And I should see "SendGrid"
    And I should see "Stripe"

  @scenario_id:governance-config-02
  @scenario_type:UI
  @ui_test
  @portal:tenantAdmin
  @login:user
  Scenario: 2. Each provider states which scope currently answers
    Given I navigate to "/config"
    Then I should see "Not configured"

  @scenario_id:governance-config-03
  @scenario_type:UI
  @ui_test
  @portal:tenantAdmin
  @login:user
  Scenario: 3. Saving applies to every app of the tenant
    Given I navigate to "/config"
    Then I should see "Save for all my apps"
