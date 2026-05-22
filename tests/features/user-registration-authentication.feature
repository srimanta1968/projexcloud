@feature_id:1fe71ae3-4bfd-4d3f-8a01-ba14f277d97e
@epic_id:56951d24-67ef-4f13-8b0d-008a1601953a
Feature: User Registration & Authentication
  Sign-up, login, JWT sessions, password hashing, and canonical identity mapping.

  @scenario_id:01b864df-3f93-40fa-9077-e3692568f474
  @scenario_type:UI
  @ui_test
  Scenario: 1. Users can register with email and password
    # Scenario ID: 01b864df-3f93-40fa-9077-e3692568f474
    # Feature ID: 1fe71ae3-4bfd-4d3f-8a01-ba14f277d97e
    # Scenario Type: UI
    # Description: 1. Users can register with email and password
    Given A visitor navigates to the ProjexCloud registration UI
    When They enter a valid email and a valid password and submit the registration form
    Then A new user account is created for that email and the UI shows a successful registration confirmation
    And The system returns an HTTP 201 (or appropriate success) and the user's record exists in the identity store with the provided email
    # Priority: medium
    # Status: draft
    # Test Runner Info: feature_id=1fe71ae3-4bfd-4d3f-8a01-ba14f277d97e, scenario_id=01b864df-3f93-40fa-9077-e3692568f474, type=UI

  @scenario_id:8a4759a3-dff9-45df-b7f2-e48b8b336fc9
  @scenario_type:UI
  @ui_test
  Scenario: 2. Registered users can log in and receive a JWT
    # Scenario ID: 8a4759a3-dff9-45df-b7f2-e48b8b336fc9
    # Feature ID: 1fe71ae3-4bfd-4d3f-8a01-ba14f277d97e
    # Scenario Type: UI
    # Description: 2. Registered users can log in and receive a JWT
    Given An existing user account exists with a known email and password
    When The user submits the correct email and password to the ProjexCloud login UI or API
    Then The system authenticates the user and returns an HTTP 200 with a JWT in the response
    And The returned JWT is signed, contains the expected claims (e.g., user id, expiry), and can be decoded and validated by the platform
    # Priority: medium
    # Status: draft
    # Test Runner Info: feature_id=1fe71ae3-4bfd-4d3f-8a01-ba14f277d97e, scenario_id=8a4759a3-dff9-45df-b7f2-e48b8b336fc9, type=UI

  @scenario_id:8e022ba8-ee4e-4b88-82b5-85757c03454d
  @scenario_type:UI
  @ui_test
  Scenario: 3. Password stored hashed and salted
    # Scenario ID: 8e022ba8-ee4e-4b88-82b5-85757c03454d
    # Feature ID: 1fe71ae3-4bfd-4d3f-8a01-ba14f277d97e
    # Scenario Type: UI
    # Description: 3. Password stored hashed and salted
    Given A user has registered with a plaintext password via the registration UI
    When An operator or test retrieves the stored credential record for that user from the identity store (read-only inspection)
    Then The stored password value is not equal to the plaintext password (i.e., the password is hashed)
    And The stored value includes evidence of salting and a recognized secure hashing format (e.g., bcrypt/argon2 parameters or salt metadata) and cannot be reversed to plaintext
    # Priority: medium
    # Status: draft
    # Test Runner Info: feature_id=1fe71ae3-4bfd-4d3f-8a01-ba14f277d97e, scenario_id=8e022ba8-ee4e-4b88-82b5-85757c03454d, type=UI
