@feature_id:343658ad-50ca-456c-a24a-a98975fffb2d
Feature: Voice key vault and presets
  A tenant admin brings their own provider key for each voice layer (LLM, speech-to-text,
  text-to-speech, realtime, telephony) at /voice/keys. Validating a key checks it with the
  provider and shows the max safe concurrency the dialer will hold it to. Preset stacks show
  their live estimated $/min and which layers still need a validated key. Raw keys are
  entered in a password field and only the last 4 characters are ever shown.

  @scenario_type:UI
  @ui_test
  @portal:tenantAdmin
  @login:user
  @scenario_id:fc4b9253-2365-43c1-9760-810c8260eace
  Scenario: 1. Tenant admin sees the key vault, per-layer sections and preset prices
    Given I navigate to "/voice/keys"
    Then I should see "Voice keys & presets"
    And I should see "Add a key"
    And I should see "Speech-to-text (STT)"
    And I should see "Telephony"
    And I should see "Preset stacks"
    And I should see "/min"

  @scenario_type:UI
  @ui_test
  @portal:tenantAdmin
  @login:user
  @scenario_id:ff4ceb4d-36d8-4014-b34f-1ed5041ce4ff
  Scenario: 2. Adding a key shows it masked and validating it reports the provider's verdict
    Given I navigate to "/voice/keys"
    When I fill "raw_key" with "sk-test-${uuid}"
    And I click "Save key"
    Then I should see "Key saved. Validate it to see its safe concurrency."
    And I should see "Not validated"
    When I click "Validate"
    Then I should see "Validation result"
