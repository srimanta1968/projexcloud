@feature_id:e5093ece-d65c-4a3e-8e8b-4f7d8f6c8410
@epic_id:f3689016-40a1-45c4-88f6-bb2fb1c6baa5
Feature: Portal authentication middleware
  Every portal route requires an authenticated session; the admin consoles are
  role-gated and privileged server actions reject unauthenticated calls.

  @scenario_id:ee5bee07-4e0b-4a80-80df-8e389e98b7fb
  @scenario_type:UI
  @ui_test
  Scenario: 1. Unauthenticated visitor is redirected to login
    Given I have no session cookie
    When I navigate to "/tenant"
    Then I should be redirected to "/login"
    And I should not see any admin content

  @scenario_id:942b6e28-a25e-49bd-942c-00578983432a
  @scenario_type:UI
  @ui_test
  Scenario: 2. Tenant-admin role required for the Tenant Admin portal
    Given I am logged in as "${credentials:tenant_admin:email}"
    When I navigate to "/tenant"
    Then I should see "Tenant Admin"
    And a user without the tenant-admin role is denied access to "/tenant"

  @scenario_id:cf996e4e-6542-47d8-9f81-6f6b88884b06
  @scenario_type:UI
  @ui_test
  Scenario: 3. Platform-operator role required for the Platform Admin console
    Given I am logged in as "${credentials:operator:email}"
    When I navigate to "/console"
    Then I should see "Platform Admin"
    And a tenant identity is denied access to "/console"

  @scenario_id:107783ac-6148-4a63-8c3a-5dddbc2b7ddb
  @scenario_type:UI
  @ui_test
  Scenario: 4. Builder role required for the Workspace portal
    Given I am logged in as "${credentials:builder:email}"
    When I navigate to "/dashboard"
    Then I should see the workspace dashboard
    And an unauthenticated visitor to "/dashboard" is redirected to "/login"

  @scenario_id:2d5ca236-e1f3-4758-b5b1-000a44879914
  @scenario_type:API
  @api_test
  Scenario: 5. Privileged server action rejects an unauthenticated request
    Given I have no valid, role-authorized session
    When I invoke the tenant-provisioning server action
    Then the action is rejected before the ADMIN_OPS_TOKEN is used
    And no tenant is created

  @scenario_id:3ed7717a-c6c2-4103-b187-8ab95cb818f3
  @scenario_type:API
  @api_test
  Scenario: 6. Expired or invalid session is rejected
    Given my session cookie holds an expired or tampered token
    When I request any protected portal route
    Then I am redirected to "/login" and must re-authenticate
    And the gateway never trusts a forwarded identity header
