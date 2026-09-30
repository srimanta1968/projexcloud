@feature_id:cee153db-cf9a-43f3-b36b-464bd390aeec
Feature: Talk to an agent — embeddable TalkToAgent widget
  The tenant portal embeds the @projexlight/voice-widget TalkToAgent widget at /voice/test,
  so an admin can hold a voice conversation with any agent — an unpublished draft included —
  through a test session. The widget asks for the microphone before connecting, shows its
  connection state (connecting, connected, waiting for the agent, muted, ended), and tells
  the user how to fix a blocked microphone instead of failing silently.

  @scenario_type:UI
  @ui_test
  @portal:tenantAdmin
  @login:user
  @scenario_id:dffbe04c-a2bf-4c93-9358-b05fbca5bcc5
  Scenario: 1. Tenant admin opens the talk-to-agent page and sees the widget
    Given I navigate to "/voice/test"
    Then I should see "Talk to an agent"
    And I should see "Talk to agent"

  @scenario_type:UI
  @ui_test
  @portal:tenantAdmin
  @login:user
  @scenario_id:6d8924e7-f2f9-45d4-9d58-c12a1af8b92c
  Scenario: 2. A blocked microphone is reported with how to fix it
    Given I navigate to "/voice/test"
    When I click "Talk to agent"
    Then I should see "Microphone blocked"
    And I should see "Allow the microphone for this site in your browser"
    And I should see "Try again"
