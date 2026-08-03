@feature_id:f7abad9d-e317-4d90-a5cb-b4a7d0a9b598
@epic_id:249cbae0-e76c-42c0-8afd-9c825f5419c7
Feature: Append-only Audit Chain
  UI coverage for the append-only ledger screen.

  REGENERATED against the UI authoring contract. Assertions quote text copied
  from apps/tenant-workspace/app/admin/audit/page.tsx. Note the previous
  revision asserted absences ("no changes are applied") and redirects, neither
  of which the runner implements — assert POSITIVE visible text instead.

  @scenario_id:298a1cd4-8c45-4b16-abd5-f2140b020009
  @scenario_type:UI
  @ui_test
  @portal:workspace
  @login:user
  Scenario: 1. Audit chain screen renders
    When I navigate to "/admin/audit"
    Then I should see "Append-only Audit Chain"

  @scenario_id:176581b3-cc71-4f4f-b8ca-15e8cffc605a
  @scenario_type:UI
  @ui_test
  @portal:workspace
  @login:user
  Scenario: 2. Ledger and append control are present
    When I navigate to "/admin/audit"
    Then I should see "Ledger"
    And I should see "Append new entry"
