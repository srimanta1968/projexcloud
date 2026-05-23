# Okta Federation Setup (AC-12 vendor integration)

This runbook documents the manual steps to wire a tenant's Okta org as both
the SAML IdP and the SCIM provisioning client for ProjexCloud. Once these
steps complete, the `SAML_ADAPTER=node-saml` deploy path and the SCIM Bearer
middleware (`scimBearerAuth`) verify everything automatically.

## Prerequisites

- Okta developer sandbox (free): https://developer.okta.com/signup/
- ProjexCloud running with the `api-gateway` service publicly reachable (or
  via ngrok tunnel for local testing)
- The tenant's `tenant_id` UUID from `tenant.tenant`
- Node 20+ for the `@node-saml/node-saml` adapter, install with:
  ```
  pnpm --filter @projexlight/sdk-identity add @node-saml/node-saml
  ```

## Part 1 — SAML SSO

1. **Get the ProjexCloud SP metadata:**
   ```
   curl https://<gateway-host>/saml/<tenant_id>/metadata > sp-metadata.xml
   ```

2. **In Okta admin → Applications → Create App Integration → SAML 2.0:**
   - **Single sign-on URL**: `https://<gateway-host>/saml/<tenant_id>/acs`
   - **Audience URI (SP Entity ID)**: `https://<gateway-host>/saml/<tenant_id>`
   - **Name ID format**: `EmailAddress`
   - **Application username**: `Email`
   - **Attribute statements**:
     - `email` → `user.email`
     - `groups` → Filter: matches regex `.*` (returns all assigned groups)

3. **Download the Okta IdP metadata.xml** from the "Sign On" tab.

4. **Insert the federation config:**
   ```sql
   INSERT INTO identity.federation_config (
     tenant_id, protocol, idp_metadata_url, idp_cert, group_role_map, jit_enabled
   ) VALUES (
     '<tenant_id>',
     'saml',
     'https://<okta-org>.okta.com/app/<app-id>/sso/saml/metadata',
     '-----BEGIN CERTIFICATE-----\n...paste from Okta metadata...\n-----END CERTIFICATE-----',
     '{
       "Doctors":        "<role_template_id_for_senior_doctor>",
       "Administrators": "<role_template_id_for_chief_of_medicine>"
     }'::jsonb,
     TRUE
   );
   ```

5. **Start the gateway with the node-saml adapter:**
   ```
   SAML_ADAPTER=node-saml pnpm --filter @projexlight/api-gateway dev
   ```

6. **Test:** click the app in your Okta dashboard. ProjexCloud should JIT-
   provision the user, attach the email + NameID aliases, and assign the
   role template that maps to the matched Okta group.

## Part 2 — SCIM 2.0 Provisioning

1. **Generate a SCIM Bearer token** in your secrets vault:
   ```
   openssl rand -hex 32 > scim-token.txt
   ```

2. **SHA-256 the token and store in the federation config row:**
   ```
   echo -n "$(cat scim-token.txt)" | sha256sum | awk '{print $1}'
   ```
   ```sql
   UPDATE identity.federation_config
      SET scim_bearer_envelope = decode('<sha256>', 'hex')
    WHERE tenant_id = '<tenant_id>'
      AND protocol = 'scim';
   ```
   (Production: wrap the raw token via sdk-vault and store the envelope.)

3. **In Okta admin → Applications → your app → Provisioning:**
   - Enable provisioning
   - **SCIM connector base URL**: `https://<gateway-host>/scim/v2`
   - **Unique identifier**: `userName`
   - **Supported provisioning actions**: Create Users, Update User Attributes,
     Deactivate Users
   - **Authentication mode**: HTTP Header
   - **Header**: `Authorization: Bearer <paste raw token from scim-token.txt>`

4. **Test connector configuration** in Okta — should respond `200 OK`.

5. **Assign users to the app in Okta.** Each assignment fires a SCIM POST
   to `/scim/v2/Users` and ProjexCloud:
   - JIT-provisions `identity.person` if email is new
   - Attaches the email alias
   - Inserts/updates `identity.tenant_membership` (status = 'active' or
     'suspended' based on Okta `active` flag)

6. **Deactivate** a user in Okta → SCIM DELETE → membership status flips
   to `'offboarded'`.

## Smoke test the round-trip

After both parts:
```bash
# SAML: open Okta dashboard, click app, expect JIT person + email alias row
psql -c "SELECT person_id, home_region FROM identity.person ORDER BY created_at DESC LIMIT 1;"

# SCIM: assign a user in Okta, expect a fresh tenant_membership row
psql -c "SELECT person_id, tenant_id, status FROM identity.tenant_membership ORDER BY created_at DESC LIMIT 1;"
```

## Failure modes

| Symptom | Cause | Fix |
|---|---|---|
| `403 SAML response missing NameID` | Okta NameID format wrong | Set to `EmailAddress` in Okta SAML config |
| `403 node-saml signature verify failed` | `idp_cert` doesn't match Okta's actual signing cert | Re-download Okta metadata, paste fresh cert |
| `401 SCIM Bearer token not recognized` | Hash mismatch between stored envelope and Okta header | Re-run step 2; raw token must match before hashing |
| Group claim not assigning role | `group_role_map` key doesn't match Okta group display name | Check exact group name in Okta admin → Groups |

## Tear down

```sql
DELETE FROM identity.federation_config WHERE tenant_id = '<tenant_id>';
```
Members survive (so their session history is preserved); their next login
falls back to OIDC password.
