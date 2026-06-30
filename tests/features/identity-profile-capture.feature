@feature_id:2d00c83d-9593-41c7-9b5b-d0079ff79a5c
@epic_id:9c09e562-b1f5-481e-983b-a4aae8891e8a
Feature: Identity profile capture & logged-in persona display
  Capture name/phone/avatar at signup and profile completion, surface the
  logged-in persona in every portal, and gate contact reads with consent.

  @scenario_id:7c871597-3ec2-414e-95ea-55ff86a7f954
  @scenario_type:API
  @api_test
  Scenario: 1. Registration captures full name and phone
    Given a signup payload with email, password, "${random_name}" and "${random_phone}"
    When I POST to "/api/auth/register"
    Then an identity.person, an L2 app_identity and a profile band are created
    And the response returns the person's display_name

  @scenario_id:176dc1c8-ca06-4270-bc99-8a62c048181d
  @scenario_type:UI
  @ui_test
  Scenario: 2. Profile completion with avatar
    Given I am logged in as "${credentials:builder:email}"
    When I navigate to "/profile"
    And I fill "Full name" with "${random_name}"
    And I fill "Phone" with "${random_phone}"
    And I fill "Avatar URL" with "https://cdn.example.com/a.png"
    And I click "Save profile"
    Then I should see "Saved. Your profile is updated."

  @scenario_id:5e894617-57c5-4ccf-9c75-161adcf97e58
  @scenario_type:UI
  @ui_test
  Scenario: 3. Logged-in persona name and avatar shown in every portal
    Given I am logged in as a user who has a display name and avatar
    When I navigate to "/dashboard"
    Then the header shows my full name and avatar
    And the same header appears on "/tenant" and "/console" when authorized

  @scenario_id:c379b189-c61f-45a0-8ab6-97e08d1264f5
  @scenario_type:API
  @api_test
  Scenario: 4. Userinfo returns display name without leaking secure data
    Given a valid session token
    When I GET "/api/userinfo"
    Then it returns display_name, email, avatar and roles
    And it never returns L1 secure data

  @scenario_id:87e375f1-7036-4b80-a20a-e3f9c7b9350d
  @scenario_type:API
  @api_test
  Scenario: 5. Tenant primary contact is captured and retrievable
    Given a tenant created via signup-tenant with a founder name and phone
    When I GET "/api/tenants/{tenant_id}/contact"
    Then it returns the founder's display_name, email and phone

  @scenario_id:cfeffac3-b93c-44d7-b103-b14a5430ec47
  @scenario_type:API
  @api_test
  Scenario: 6. Reading contact phone/email is consent-gated and audited
    Given a tenant contact with no consent receipt
    When I GET "/api/tenants/{tenant_id}/contact?purpose=marketing"
    Then the read fails closed with 403 "consent_absent"
    And the access attempt is written to the audit ledger
