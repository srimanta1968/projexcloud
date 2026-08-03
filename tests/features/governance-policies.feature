@feature_id:684b62bf-089e-4894-9d7c-60a944606f8d
@epic_id:b7b01410-f1b7-4919-a8cd-d7eb77b9e953
Feature: Access policies with a dry run
  A tenant admin authors attribute-based rules and can PREVIEW a decision before
  saving. The dry run is the point of the screen: a policy engine whose decisions
  cannot be previewed gets switched off the first time it denies something
  important, because nobody can tell a correct denial from a misconfigured one.

  @scenario_id:governance-policies-01
  @scenario_type:UI
  @ui_test
  @portal:tenantAdmin
  @login:user
  Scenario: 1. Tenant admin opens the policies screen
    Given I navigate to "/policies"
    Then I should see "Policies"

  @scenario_id:governance-policies-02
  @scenario_type:UI
  @ui_test
  @portal:tenantAdmin
  @login:user
  Scenario: 2. A context can be evaluated without saving a rule
    Given I navigate to "/policies"
    Then I should see "Evaluate a context (nothing is saved)"
    And I should see "Evaluate"

  @scenario_id:governance-policies-03
  @scenario_type:UI
  @ui_test
  @portal:tenantAdmin
  @login:user
  Scenario: 3. Past decisions are browsable so a denial can be explained
    Given I navigate to "/policies"
    Then I should see "Recent decisions"
