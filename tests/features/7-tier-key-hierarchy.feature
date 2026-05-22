@feature_id:7dafe3f8-16b6-4dbe-80dc-3362158e5b1f
@epic_id:ee93bf20-3149-45d5-a712-d55cc74df2d9
Feature: 7-Tier Key Hierarchy
  Implement the canonical 7-tier key hierarchy and cryptographic shred operations.

  @scenario_id:c09f06ad-9316-4b31-a074-d7693d252a42
  @scenario_type:UI
  @ui_test
  Scenario: 1. Key tiers can be created and linked
    # Scenario ID: c09f06ad-9316-4b31-a074-d7693d252a42
    # Feature ID: 7dafe3f8-16b6-4dbe-80dc-3362158e5b1f
    # Scenario Type: UI
    # Description: 1. Key tiers can be created and linked
    Given an authenticated administrator is on the 7-Tier Key Hierarchy management UI for project ProjexCloud
    And the canonical 7-tier template and required parent tiers are available to create
    When the administrator creates the required key tiers (all seven tiers) using the UI create flow
    And the administrator links child tiers to their correct parent tiers using the UI link operation
    And the administrator saves the hierarchy and reloads the key hierarchy view
    Then each created key tier is displayed in the UI with the expected name and attributes
    And the parent-child links between tiers are shown correctly in the hierarchy view
    And the created tiers and their links are returned by the backend API and persist after reload
    # Priority: high
    # Status: draft
    # Test Runner Info: feature_id=7dafe3f8-16b6-4dbe-80dc-3362158e5b1f, scenario_id=c09f06ad-9316-4b31-a074-d7693d252a42, type=UI

  @scenario_id:dafb42b3-9bd0-48b4-ba21-2e3e94f8036a
  @scenario_type:UI
  @ui_test
  Scenario: 2. Shred renders keys unrecoverable
    # Scenario ID: dafb42b3-9bd0-48b4-ba21-2e3e94f8036a
    # Feature ID: 7dafe3f8-16b6-4dbe-80dc-3362158e5b1f
    # Scenario Type: UI
    # Description: 2. Shred renders keys unrecoverable
    Given an authenticated administrator has access to a target key (or key material) in a specific tier within ProjexCloud and the key is currently usable for encryption/decryption operations
    And there is a UI shred action available for that key and a test artifact encrypted with that key available for validation
    When the administrator triggers the cryptographic shred operation for the target key via the UI and confirms the destructive action
    And the system completes the shred operation and returns success status
    Then the shredded key is no longer available via the UI or backend API (requests to retrieve key material return not found or unrecoverable)
    And attempts to decrypt the test artifact using the shredded key fail (data is unrecoverable)
    And export or backup operations do not return the shredded key material and audit logs record the shred operation
    # Priority: medium
    # Status: draft
    # Test Runner Info: feature_id=7dafe3f8-16b6-4dbe-80dc-3362158e5b1f, scenario_id=dafb42b3-9bd0-48b4-ba21-2e3e94f8036a, type=UI

  @scenario_id:00e367f9-aaf9-444b-a511-c9e8edf73771
  @scenario_type:UI
  @ui_test
  Scenario: 3. Key metadata persisted
    # Scenario ID: 00e367f9-aaf9-444b-a511-c9e8edf73771
    # Feature ID: 7dafe3f8-16b6-4dbe-80dc-3362158e5b1f
    # Scenario Type: UI
    # Description: 3. Key metadata persisted
    Given an authenticated user creates a new key in a specific tier and provides a defined set of metadata fields (e.g., owner, creation timestamp, purpose, tags) via the UI
    And the backend persistence layer is available and the UI is connected to it
    When the user saves the key and associated metadata and navigates away from and then back to the key details view
    And the user fetches the key metadata via the backend API directly to validate persisted values
    Then the UI displays the same metadata values that were entered when creating the key
    And the backend API returns the exact metadata values and timestamps matching the UI inputs
    And metadata persists across UI reloads, sessions, and is indexed/searchable as applicable
    # Priority: medium
    # Status: draft
    # Test Runner Info: feature_id=7dafe3f8-16b6-4dbe-80dc-3362158e5b1f, scenario_id=00e367f9-aaf9-444b-a511-c9e8edf73771, type=UI
