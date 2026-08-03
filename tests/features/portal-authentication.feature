@feature_id:e5093ece-d65c-4a3e-8e8b-4f7d8f6c8410
@epic_id:f3689016-40a1-45c4-88f6-bb2fb1c6baa5
Feature: Portal authentication middleware
  Each portal exposes its own sign-in surface.

  REGENERATED against the UI authoring contract. Each scenario asserts text
  UNIQUE to its portal ("Tenant Admin", "Platform Admin") rather than a generic
  "Sign in" — a generic assertion would also pass on the wrong portal and so
  would prove nothing about @portal: routing.

  @scenario_id:ee5bee07-4e0b-4a80-80df-8e389e98b7fb
  @scenario_type:UI
  @ui_test
  @portal:workspace
  Scenario: 1. Workspace exposes a sign-in form
    When I navigate to "/login"
    Then I should see "Sign in"

  @scenario_id:942b6e28-a25e-49bd-942c-00578983432a
  @scenario_type:UI
  @ui_test
  @portal:tenantAdmin
  Scenario: 2. Tenant Admin console exposes its own sign-in
    When I navigate to "/login"
    Then I should see "Tenant Admin"
