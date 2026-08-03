-- Per-def seed for sdk-data-credits (EP-378): the credit account for the tenant this
-- run created. Referenced by the definitions that hold or spend credits via
-- "testability": "semi-auto" + "setupScript": "data_credits_account.sql", so the runner
-- executes it AFTER the signup-tenant producer has resolved and the {{cache:}} below has
-- a real tenant id.
--
-- Credits are granted by an operator, not by an API — there is no self-service top-up
-- endpoint — so a seed is the correct mechanism rather than a producer chain.
--
-- Idempotent: a re-run tops the account back up to a known floor rather than adding to
-- it, so a suite that spends credits starts from the same place every time WITHOUT the
-- balance drifting upward across runs.
INSERT INTO data_credits.credit_account (tenant_id, balance, reserved)
VALUES ('{{cache:auth.signup-tenant.response.data.tenant_id}}', 100.0000, 0)
ON CONFLICT (tenant_id) DO UPDATE
   SET balance = GREATEST(data_credits.credit_account.balance, 100.0000);

-- The matching ledger entry, so the balance did not appear from nowhere: every credit
-- movement is on the record, including the ones an operator makes.
INSERT INTO data_credits.credit_ledger
  (tenant_id, entry_type, balance_delta, reserved_delta, balance_after, reserved_after, reason)
SELECT a.tenant_id, 'GRANT', 100.0000, 0, a.balance, a.reserved, 'api-test fixture grant'
  FROM data_credits.credit_account a
 WHERE a.tenant_id = '{{cache:auth.signup-tenant.response.data.tenant_id}}'
   AND NOT EXISTS (
     SELECT 1 FROM data_credits.credit_ledger l
      WHERE l.tenant_id = a.tenant_id AND l.entry_type = 'GRANT'
        AND l.reason = 'api-test fixture grant');
