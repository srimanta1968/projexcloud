@feature_id:343658ad-50ca-456c-a24a-a98975fffb2d
Feature: Voice agent builder — build, preview, test and publish
  A tenant admin builds an AI voice agent in the tenant portal: creates the agent, clones a
  preset stack with a validated key per slot, saves an immutable version, previews a voice
  with their own TTS key, talks to the draft with the TalkToAgent widget, evaluates it with
  simulated callers (a passing evaluation run gates publishing; a free sandbox check never
  does), requests approval, and publishes once an approver has approved. A previously
  published version can be rolled back to.

  @scenario_type:UI
  @ui_test
  @portal:tenantAdmin
  @login:user
  @scenario_id:e994d40c-6e07-4214-9600-509286fabc87
  Scenario: 1. Tenant admin creates an agent and lands on the builder
    Given I navigate to "/voice/agents"
    Then I should see "Voice agents"
    When I fill "name" with "Front desk ${timestamp}"
    And I click "Create agent"
    Then I should see "Agent created. Start with a stack, then a first version."
    And I should see "1. Stack from a preset"
    And I should see "3. Preview a voice"
    And I should see "4. Test the latest version"
    And I should see "5. Evaluate with simulated callers"
    And I should see "6. Versions & publish"

  @scenario_type:UI
  @ui_test
  @portal:tenantAdmin
  @login:user
  @scenario_id:3a9a84c2-b409-4716-859e-d2181e4dc86b
  Scenario: 2. Publishing is refused until the version is tested and approved
    Given I navigate to "/voice/agents"
    When I fill "name" with "Gated agent ${timestamp}"
    And I click "Create agent"
    And I click "Create stack"
    Then I should see "Stack profile created."
    When I fill "system_prompt" with "You are the front desk. Book appointments."
    And I click "Save version"
    Then I should see "Version saved."
    And I should see "draft"
    When I click "Publish"
    Then I should see "no evaluation run recorded for this version"

  @scenario_type:UI
  @ui_test
  @portal:tenantAdmin
  @login:user
  @scenario_id:30eb51db-0654-4753-b33f-addeef67c192
  Scenario: 3. A sandbox check runs simulated callers but never unlocks publishing
    Given I navigate to "/voice/agents"
    When I fill "name" with "Sandbox agent ${timestamp}"
    And I click "Create agent"
    And I click "Create stack"
    Then I should see "Stack profile created."
    When I fill "system_prompt" with "You are the front desk. Book appointments."
    And I click "Save version"
    Then I should see "Version saved."
    And I should see "not evaluated"
    When I click "Sandbox check"
    Then I should see "Sandbox checks run on fake speech providers with a scripted agent"
    And I should see "never count toward publishing"
