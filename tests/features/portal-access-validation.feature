@feature_id:a1b2c3d4-0001-4a00-9000-portalvalid01
@epic_id:f3689016-40a1-45c4-88f6-bb2fb1c6baa5
Feature: Portal access validation
  Smoke-validate that ProjexCloud's three portals are reachable and correctly
  gate anonymous visitors to the login page. These scenarios need no credentials
  and perform no mutations — they only navigate and assert redirects / visible
  content, so they are safe to run against the live environment.

  @scenario_id:a1b2c3d4-1001-4a00-9000-portalvalid01
  @scenario_type:UI
  @ui_test
  Scenario: 1. Login page renders for anonymous visitors
    Given I have no session cookie
    When I navigate to "/login"
    Then I should see a login form with email and password fields

  @scenario_id:a1b2c3d4-1002-4a00-9000-portalvalid01
  @scenario_type:UI
  @ui_test
  Scenario: 2. Tenant Admin portal redirects anonymous visitors to login
    Given I have no session cookie
    When I navigate to "/tenant"
    Then I should be redirected to the login page
    And I should not see any tenant admin content

  @scenario_id:a1b2c3d4-1003-4a00-9000-portalvalid01
  @scenario_type:UI
  @ui_test
  Scenario: 3. Platform Admin console redirects anonymous visitors to login
    Given I have no session cookie
    When I navigate to "/console"
    Then I should be redirected to the login page
    And I should not see any platform admin content

  @scenario_id:a1b2c3d4-1004-4a00-9000-portalvalid01
  @scenario_type:UI
  @ui_test
  Scenario: 4. Workspace portal redirects anonymous visitors to login
    Given I have no session cookie
    When I navigate to "/dashboard"
    Then I should be redirected to the login page
    And I should not see the workspace dashboard
