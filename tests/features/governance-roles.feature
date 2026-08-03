@feature_id:4e38857d-60d2-4e26-a208-0f7877b94e0f
@epic_id:b7b01410-f1b7-4919-a8cd-d7eb77b9e953
Feature: Role templates per app
  The tenant-admin portal lets an admin see the role templates for each of their
  apps. tenant.role_template has a NULLABLE tenant_id: a NULL row is the platform
  default shipped with the app, a tenant_id row is this tenant's override of the
  SAME role name. The screen must show that difference, because if overriding were
  implicit every tenant would end up owning a private copy of every default role.

  @scenario_id:governance-roles-01
  @scenario_type:UI
  @ui_test
  @portal:tenantAdmin
  @login:user
  Scenario: 1. Tenant admin opens the roles screen
    Given I navigate to "/roles"
    Then I should see "Roles"
    And I should see "Origin"

  @scenario_id:governance-roles-02
  @scenario_type:UI
  @ui_test
  @portal:tenantAdmin
  @login:user
  Scenario: 2. A platform default is labelled as inherited rather than owned
    Given I navigate to "/roles"
    Then I should see "Inherited platform default"

  @scenario_id:governance-roles-03
  @scenario_type:UI
  @ui_test
  @portal:tenantAdmin
  @login:user
  Scenario: 3. Overriding a role is an explicit action
    Given I navigate to "/roles"
    Then I should see "Override for my tenant"
