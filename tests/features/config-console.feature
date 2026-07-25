@feature_id:c0nf1901-0001-4a00-9000-consoleconf01
@epic_id:c0nf1901-e000-4a00-9000-consoleconf01
Feature: Console platform configuration
  Smoke-validate that the platform-operator console exposes the platform
  configuration surface. Navigate and assert POSITIVE visible text only
  (FEATURE-06 vocabulary) so this is safe against any environment.

  @scenario_id:c0nf1901-1001-4a00-9000-consoleconf01
  @scenario_type:UI
  @ui_test
  @portal:console
  Scenario: 1. Platform Configuration page renders its config cards
    When I navigate to "/config"
    Then I should see "Platform Configuration"
    And I should see "Default LLM provider"
