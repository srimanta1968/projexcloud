-- Migration 003: store the wrapped Tenant Key material on each BYOK binding.
-- Closes G-P8-2 from the P8 audit — without this column, bindCmk has nothing
-- to persist after calling kmsProvider.wrap(), so the Tenant Key is never
-- actually sealed under the customer's CMK.

ALTER TABLE vault.byok_binding
  ADD COLUMN IF NOT EXISTS wrapped_tenant_key_material BYTEA;

COMMENT ON COLUMN vault.byok_binding.wrapped_tenant_key_material
  IS 'Tenant Key ciphertext sealed under customer CMK. Unwrap requires an active grant; revoke makes this row inert (FR-BYOK-2/3).';
