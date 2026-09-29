-- Rollback for 005_voice_channel.sql. NOT auto-applied. Fails while 'voice' rows exist.
ALTER TABLE deliverability.suppression DROP CONSTRAINT IF EXISTS suppression_channel_check;
ALTER TABLE deliverability.suppression
  ADD CONSTRAINT suppression_channel_check CHECK (channel IN ('email','sms','all'));
ALTER TABLE deliverability.optout_token DROP CONSTRAINT IF EXISTS optout_token_channel_check;
ALTER TABLE deliverability.optout_token
  ADD CONSTRAINT optout_token_channel_check CHECK (channel IN ('email','sms','all'));
