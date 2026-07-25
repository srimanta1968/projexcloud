@feature_id:e173c7f1-32ac-4dbc-8b78-d251193bceac
@epic_id:91acfe5f-bb66-4386-8a34-b5090d47e309
Feature: Tenant Settings & Integrations hub
  The tenant-admin portal exposes a unified Settings/Integrations page where a
  tenant admin brings their own providers (AWS/S3, payment collection, email,
  search, LLM). Values written here are tenant-scoped and override the platform
  defaults.

  @scenario_id:4e232cbc-47ed-4a43-927e-15fed8894558
  @scenario_type:UI
  @ui_test
  @portal:tenantAdmin
  Scenario: 1. Tenant admin sees the Settings & Integrations hub
    Given I navigate to "/config"
    Then I should see "Settings & Integrations"
    And I should see "Payment collection"
