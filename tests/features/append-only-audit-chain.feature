@feature_id:f7abad9d-e317-4d90-a5cb-b4a7d0a9b598
@epic_id:249cbae0-e76c-42c0-8afd-9c825f5419c7
Feature: Append-only Audit Chain
  Immutable ledger for events with hash chaining.

  @scenario_id:298a1cd4-8c45-4b16-abd5-f2140b020009
  @scenario_type:UI
  @ui_test
  Scenario: 1. Appends create new ledger rows
    # Scenario ID: 298a1cd4-8c45-4b16-abd5-f2140b020009
    # Feature ID: f7abad9d-e317-4d90-a5cb-b4a7d0a9b598
    # Scenario Type: UI
    # Description: 1. Appends create new ledger rows
    Given A user with append permission is authenticated and is viewing the Append-only Audit Chain ledger in the UI
    And The ledger currently contains N rows (N >= 0) and the UI is displaying the current row count
    When The user appends a new event via the Append Event UI, providing a valid event payload and submitting the form
    And The append operation completes successfully and the UI shows a success confirmation
    Then The ledger shows a new row appended to the end corresponding to the submitted event
    And The displayed ledger row count has increased by exactly one compared to N
    # Priority: medium
    # Status: draft
    # Test Runner Info: feature_id=f7abad9d-e317-4d90-a5cb-b4a7d0a9b598, scenario_id=298a1cd4-8c45-4b16-abd5-f2140b020009, type=UI

  @scenario_id:176581b3-cc71-4f4f-b8ca-15e8cffc605a
  @scenario_type:UI
  @ui_test
  Scenario: 2. Each row contains hash linking to previous
    # Scenario ID: 176581b3-cc71-4f4f-b8ca-15e8cffc605a
    # Feature ID: f7abad9d-e317-4d90-a5cb-b4a7d0a9b598
    # Scenario Type: UI
    # Description: 2. Each row contains hash linking to previous
    Given A user with append permission is authenticated and is viewing the Append-only Audit Chain ledger in the UI
    And The ledger contains at least one existing row with a recorded hash value for the latest row
    When The user appends a new event via the Append Event UI and the append completes successfully
    Then The newly created ledger row includes a hash field visible in the UI
    And The hash in the new row contains (or references) the previous row's hash such that the chain linkage can be verified (i.e., the new row links to the previous row)
    # Priority: medium
    # Status: draft
    # Test Runner Info: feature_id=f7abad9d-e317-4d90-a5cb-b4a7d0a9b598, scenario_id=176581b3-cc71-4f4f-b8ca-15e8cffc605a, type=UI

  @scenario_id:5b50ce35-f7a3-49e7-bc87-bd5793fdf997
  @scenario_type:UI
  @ui_test
  Scenario: 3. Ledger rows are immutable via API
    # Scenario ID: 5b50ce35-f7a3-49e7-bc87-bd5793fdf997
    # Feature ID: f7abad9d-e317-4d90-a5cb-b4a7d0a9b598
    # Scenario Type: UI
    # Description: 3. Ledger rows are immutable via API
    Given A ledger exists with at least one row and an API client has valid credentials for the tenant
    And The current content and hash of a selected ledger row are recorded for later comparison
    When The API client attempts to modify the selected ledger row via the ledger API (e.g., PUT/PATCH) with different content
    And The API client attempts to delete the selected ledger row via the ledger API (e.g., DELETE)
    Then All modification or deletion attempts are rejected by the API (appropriate error code such as 4xx/405) and no changes are applied
    And A subsequent read of the selected ledger row via the API returns the original, unchanged content and original hash
    # Priority: medium
    # Status: draft
    # Test Runner Info: feature_id=f7abad9d-e317-4d90-a5cb-b4a7d0a9b598, scenario_id=5b50ce35-f7a3-49e7-bc87-bd5793fdf997, type=UI
