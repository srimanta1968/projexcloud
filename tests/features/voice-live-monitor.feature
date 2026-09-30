@feature_id:095f8479-500d-4e1e-8243-578b788fb8aa
Feature: Live call monitor and transcript viewer
  In the workspace, /voice/monitor lists the tenant's active AI calls (refreshed every few
  seconds). A supervisor opens one to follow its transcript live over a ticketed WebSocket —
  new turns, status changes and the end of the call appear without a reload — and opens
  completed calls to read their transcript, summary and outcome.

  @scenario_type:UI
  @ui_test
  @portal:workspace
  @login:user
  @scenario_id:c3b1b830-a9bc-4c0d-a397-abfb8717d2f9
  Scenario: 1. Supervisor opens the live call monitor
    Given I navigate to "/voice/monitor"
    Then I should see "Live calls"
    And I should see "Active calls"
    And I should see "Completed calls"
