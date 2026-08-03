@feature_id:2d00c83d-9593-41c7-9b5b-d0079ff79a5c
@epic_id:9c09e562-b1f5-481e-983b-a4aae8891e8a
Feature: Identity profile capture & logged-in persona display
  UI coverage for the profile capture screen.

  REGENERATED against the UI authoring contract. Assertion text copied from
  apps/tenant-workspace/app/profile/page.tsx.

  @scenario_id:7c871597-3ec2-414e-95ea-55ff86a7f954
  @scenario_type:UI
  @ui_test
  @portal:workspace
  @login:user
  Scenario: 1. Profile capture screen renders
    When I navigate to "/profile"
    Then I should see "Complete your profile"
