@feature_id:a1b2c3d4-0001-4a00-9000-portalvalid01
@epic_id:f3689016-40a1-45c4-88f6-bb2fb1c6baa5
Feature: Portal access validation
  Smoke-validate that ProjexCloud's portals are reachable and that anonymous
  visitors land on a sign-in surface. No credentials, no mutations — navigate
  and assert visible text only, so this is safe against any environment.

  PORTAL-AWARE (MUST-43): every scenario carries @portal:<name>, resolved to
  that portal's url for the ACTIVE environment, and every step uses a RELATIVE
  path that joins onto it. One file therefore works in dev (workspace :3000,
  tenantAdmin :3200, console :3100) and in prod (one origin behind nginx under
  /workspace, /tenant, /console).

  STEP VOCABULARY (FEATURE-06): only navigate / fill / click / select /
  should-see are executable. Earlier revisions used "I should be redirected to
  the login page" and "I should not see any tenant admin content" — neither
  exists in the parser, so those steps silently failed to parse and the
  scenarios could never pass. Assert POSITIVE visible text on the destination
  instead of asserting a redirect or an absence.

  @scenario_id:a1b2c3d4-1001-4a00-9000-portalvalid01
  @scenario_type:UI
  @ui_test
  @portal:workspace
  Scenario: 1. Login page renders for anonymous visitors
    When I navigate to "/login"
    Then I should see "Sign in"

  @scenario_id:a1b2c3d4-1002-4a00-9000-portalvalid01
  @scenario_type:UI
  @ui_test
  @portal:tenantAdmin
  Scenario: 2. Tenant Admin portal is reachable
    When I navigate to "/login"
    Then I should see "Tenant Admin"

  @scenario_id:a1b2c3d4-1003-4a00-9000-portalvalid01
  @scenario_type:UI
  @ui_test
  @portal:console
  Scenario: 3. Platform Admin console is reachable
    When I navigate to "/login"
    Then I should see "Platform Admin"

  @scenario_id:a1b2c3d4-1004-4a00-9000-portalvalid01
  @scenario_type:UI
  @ui_test
  @portal:workspace
  Scenario: 4. Workspace register page renders
    When I navigate to "/register"
    Then I should see "Sign in"
