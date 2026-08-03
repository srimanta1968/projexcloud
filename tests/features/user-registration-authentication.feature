@feature_id:1fe71ae3-4bfd-4d3f-8a01-ba14f277d97e
@epic_id:56951d24-67ef-4f13-8b0d-008a1601953a
Feature: User Registration & Authentication
  Registration and sign-in surfaces on the workspace portal.

  REGENERATED against the UI authoring contract. The login inputs carry
  id="login-email" / id="login-password" and NO name attribute, so the quoted
  field names below resolve through the runner's id strategy
  (input[id*='email' i]) — the quoted string is a SELECTOR KEY copied from the
  component, not an invented label.

  @scenario_id:01b864df-3f93-40fa-9077-e3692568f474
  @scenario_type:UI
  @ui_test
  @portal:workspace
  Scenario: 1. Registration page renders
    When I navigate to "/register"
    Then I should see "Create your personal account"

  @scenario_id:8a4759a3-dff9-45df-b7f2-e48b8b336fc9
  @scenario_type:UI
  @ui_test
  @portal:workspace
  Scenario: 2. Sign-in form accepts credentials
    When I navigate to "/login"
    And I fill "email" with "${random_email}"
    And I fill "password" with "${random_password}"
    Then I should see "Sign in"
