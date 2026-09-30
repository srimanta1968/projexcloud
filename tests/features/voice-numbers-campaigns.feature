@feature_id:343658ad-50ca-456c-a24a-a98975fffb2d
Feature: Voice numbers and campaigns
  A tenant admin binds a phone number to an agent at /voice/numbers, and runs outbound
  campaigns at /voice/campaigns: create one for an outbound agent, upload contacts (one
  per line), then start, pause, resume or cancel it. The campaign page shows its status,
  recipient-local calling hours and progress by contact status.

  @scenario_type:UI
  @ui_test
  @portal:tenantAdmin
  @login:user
  @scenario_id:25f5ccba-583b-490c-813e-5e6cf4439e41
  Scenario: 1. Tenant admin sees the number binding form
    Given I navigate to "/voice/numbers"
    Then I should see "Phone numbers"
    And I should see "Bind a number"

  @scenario_type:UI
  @ui_test
  @portal:tenantAdmin
  @login:user
  @scenario_id:81609141-9cbc-436b-93ad-16b01b132254
  Scenario: 2. Tenant admin creates a campaign, adds contacts and starts, pauses and resumes it
    Given I navigate to "/voice/campaigns"
    When I fill "name" with "Campaign ${timestamp}"
    And I click "Create campaign"
    Then I should see "Campaign created. Upload contacts, then start it."
    When I fill "contacts" with "+14155550301"
    And I click "Upload contacts"
    Then I should see "1 added"
    When I click "Start"
    Then I should see "Campaign started."
    And I should see "running"
    When I click "Pause"
    Then I should see "Campaign paused."
    When I click "Resume"
    Then I should see "Campaign resumed."
