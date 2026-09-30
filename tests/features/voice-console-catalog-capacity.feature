@feature_id:095f8479-500d-4e1e-8243-578b788fb8aa
Feature: Operator console — voice catalog and capacity
  Platform operators edit the voice provider catalog (display name, list price,
  certification, price verified) at /voice/catalog, and watch per-tenant active AI calls
  against each tenant's plan concurrency cap at /voice/capacity, with tenants at their 80 %
  alert point or at the cap flagged.

  @scenario_type:UI
  @ui_test
  @portal:console
  @login:admin
  @scenario_id:0884cbe4-5062-49e1-a35a-4c4dc09b298a
  Scenario: 1. Operator sees the voice catalog with certification and edit controls
    Given I navigate to "/voice/catalog"
    Then I should see "Voice catalog"
    And I should see "certified"
    And I should see "price verified today"

  @scenario_type:UI
  @ui_test
  @portal:console
  @login:admin
  @scenario_id:ed7db713-b592-4582-9353-57b71ae90e83
  Scenario: 2. Operator sees per-tenant voice capacity
    Given I navigate to "/voice/capacity"
    Then I should see "Voice capacity"
    And I should see "Active calls"
    And I should see "At cap"
