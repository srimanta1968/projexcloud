-- Migration 001: sdk-speech — the voice provider catalog. VA·E4 (TK-4489).
-- Auto-applied via api-gateway runMigrations.
--
-- One row per provider/model a voice agent can use, per layer:
--   stt       speech-to-text            priced per audio minute
--   tts       text-to-speech            priced per 1k characters or per audio minute
--   llm       LLM used for voice turns  priced per 1M input tokens (+ output_list_price)
--   realtime  speech-to-speech model    priced per call minute
-- Telephony is not in the catalog: it is the tenant's carrier account, priced by it.
--
-- Platform reference data, shared by every tenant: no tenant_id, no RLS. Operators edit
-- prices and certification at runtime (no deploy); the seed below is inserted
-- ON CONFLICT DO NOTHING, so a later boot never overwrites an operator's edit.
--
-- Certification: an entry is selectable in a preset / stack profile only when
-- certification_status = 'certified'. The preset defaults are seeded as certified with
-- cert_metrics.provisional = true until the evaluation harness certifies them; every
-- other entry starts uncertified. Seed prices are approximate list prices
-- (VoiceAgent-Architecture-v3.1 §8); price_verified_at NULL = not yet re-verified.
--
-- Idempotent; down in ../down/.

CREATE SCHEMA IF NOT EXISTS speech;

CREATE TABLE IF NOT EXISTS speech.catalog_entry (
  entry_id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  layer                 TEXT NOT NULL CHECK (layer IN ('stt','tts','llm','realtime')),
  provider              TEXT NOT NULL CHECK (provider ~ '^[a-z0-9][a-z0-9_-]*$'),
  model                 TEXT NOT NULL CHECK (length(model) BETWEEN 1 AND 200),
  -- Stable reference presets and stack profiles use instead of raw model strings.
  catalog_key           TEXT GENERATED ALWAYS AS (layer || ':' || provider || ':' || model) STORED,
  display_name          TEXT NOT NULL,
  voices                JSONB NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(voices) = 'array'),
  languages             TEXT[] NOT NULL DEFAULT '{}',
  list_price            NUMERIC(14,6) NOT NULL CHECK (list_price >= 0),
  unit                  TEXT NOT NULL CHECK (unit IN ('per_minute','per_1k_chars','per_1m_tokens')),
  output_list_price     NUMERIC(14,6) CHECK (output_list_price >= 0),  -- output side of per_1m_tokens
  currency              TEXT NOT NULL DEFAULT 'USD' CHECK (currency ~ '^[A-Z]{3}$'),
  price_verified_at     TIMESTAMPTZ,
  certification_status  TEXT NOT NULL DEFAULT 'uncertified'
                          CHECK (certification_status IN ('certified','uncertified','revoked')),
  certified_at          TIMESTAMPTZ,
  cert_metrics          JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(cert_metrics) = 'object'),
  notes                 TEXT,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by            TEXT,
  CONSTRAINT catalog_entry_unique UNIQUE (layer, provider, model),
  CONSTRAINT catalog_entry_key_unique UNIQUE (catalog_key),
  CONSTRAINT catalog_entry_token_pricing CHECK ((unit = 'per_1m_tokens') = (output_list_price IS NOT NULL)),
  CONSTRAINT catalog_entry_certified_at CHECK ((certification_status = 'certified') = (certified_at IS NOT NULL))
);

CREATE INDEX IF NOT EXISTS catalog_entry_layer_idx ON speech.catalog_entry (layer, certification_status);

INSERT INTO speech.catalog_entry
  (layer, provider, model, display_name, voices, languages, list_price, unit, output_list_price,
   certification_status, certified_at, cert_metrics, notes)
VALUES
  -- STT
  ('stt', 'deepgram', 'nova-3', 'Deepgram Nova-3 (streaming)', '[]',
   '{en,es,fr,de,hi,ru,pt,ja,it,nl}', 0.0077, 'per_minute', NULL,
   'certified', now(), '{"source":"seed","provisional":true}', 'Balanced and Premium preset STT'),
  ('stt', 'assemblyai', 'universal-streaming', 'AssemblyAI Universal-Streaming', '[]',
   '{en}', 0.0025, 'per_minute', NULL,
   'certified', now(), '{"source":"seed","provisional":true}', 'Budget preset STT'),
  ('stt', 'openai', 'gpt-4o-mini-transcribe', 'OpenAI GPT-4o mini Transcribe', '[]',
   '{en,es,fr,de,hi,pt,ja,it}', 0.003, 'per_minute', NULL,
   'uncertified', NULL, '{}', NULL),
  -- TTS
  ('tts', 'cartesia', 'sonic-2', 'Cartesia Sonic 2', '[]',
   '{en,es,fr,de,hi,pt,ja,it,zh,ko}', 0.03, 'per_1k_chars', NULL,
   'certified', now(), '{"source":"seed","provisional":true}', 'Balanced preset TTS'),
  ('tts', 'elevenlabs', 'eleven_flash_v2_5', 'ElevenLabs Flash v2.5',
   '[{"id":"21m00Tcm4TlvDq8ikWAM","name":"Rachel","language":"en"}]',
   '{en,es,fr,de,hi,pt,ja,it,zh,ko}', 0.05, 'per_1k_chars', NULL,
   'certified', now(), '{"source":"seed","provisional":true}', 'Premium preset TTS'),
  ('tts', 'openai', 'gpt-4o-mini-tts', 'OpenAI GPT-4o mini TTS',
   '[{"id":"alloy","name":"Alloy"},{"id":"ash","name":"Ash"},{"id":"coral","name":"Coral"},{"id":"echo","name":"Echo"},{"id":"nova","name":"Nova"},{"id":"onyx","name":"Onyx"},{"id":"sage","name":"Sage"},{"id":"shimmer","name":"Shimmer"}]',
   '{en,es,fr,de,hi,pt,ja,it}', 0.015, 'per_minute', NULL,
   'certified', now(), '{"source":"seed","provisional":true}', 'Budget preset TTS'),
  ('tts', 'deepgram', 'aura-2', 'Deepgram Aura-2',
   '[{"id":"aura-2-thalia-en","name":"Thalia","language":"en"},{"id":"aura-2-apollo-en","name":"Apollo","language":"en"}]',
   '{en}', 0.03, 'per_1k_chars', NULL,
   'uncertified', NULL, '{}', NULL),
  -- LLM for voice turns
  ('llm', 'openai', 'gpt-4.1-mini', 'OpenAI GPT-4.1 mini', '[]', '{}', 0.40, 'per_1m_tokens', 1.60,
   'certified', now(), '{"source":"seed","provisional":true}', 'Fast- or complex-turn LLM in every preset'),
  ('llm', 'groq', 'llama-3.1-8b-instant', 'Groq Llama 3.1 8B Instant', '[]', '{}', 0.05, 'per_1m_tokens', 0.08,
   'certified', now(), '{"source":"seed","provisional":true}', 'Budget preset fast LLM'),
  ('llm', 'anthropic', 'claude-haiku-4-5', 'Claude Haiku 4.5', '[]', '{}', 1.00, 'per_1m_tokens', 5.00,
   'certified', now(), '{"source":"seed","provisional":true}', 'Balanced preset complex-turn LLM'),
  ('llm', 'anthropic', 'claude-sonnet-5', 'Claude Sonnet 5', '[]', '{}', 3.00, 'per_1m_tokens', 15.00,
   'certified', now(), '{"source":"seed","provisional":true}', 'Premium preset complex-turn LLM'),
  ('llm', 'gemini', 'gemini-2.5-flash', 'Gemini 2.5 Flash', '[]', '{}', 0.30, 'per_1m_tokens', 2.50,
   'uncertified', NULL, '{}', NULL),
  ('llm', 'gemini', 'gemini-2.5-flash-lite', 'Gemini 2.5 Flash-Lite', '[]', '{}', 0.10, 'per_1m_tokens', 0.40,
   'uncertified', NULL, '{}', NULL),
  ('llm', 'bedrock', 'amazon.nova-lite-v1:0', 'Amazon Nova Lite (Bedrock)', '[]', '{}', 0.06, 'per_1m_tokens', 0.24,
   'uncertified', NULL, '{}', NULL),
  -- Realtime speech-to-speech (P4)
  ('realtime', 'openai', 'gpt-realtime', 'OpenAI Realtime', '[]', '{en,es,fr,de,hi,pt,ja,it}', 0.18, 'per_minute', NULL,
   'uncertified', NULL, '{}', 'P4; per-minute price estimated from token pricing'),
  ('realtime', 'gemini', 'gemini-live-2.5-flash', 'Gemini Live 2.5 Flash', '[]', '{en,es,fr,de,hi,pt,ja,it}', 0.04, 'per_minute', NULL,
   'uncertified', NULL, '{}', 'P4; per-minute price estimated from token pricing'),
  ('realtime', 'bedrock', 'amazon.nova-sonic-v1:0', 'Amazon Nova Sonic (Bedrock)', '[]', '{en,es}', 0.03, 'per_minute', NULL,
   'uncertified', NULL, '{}', 'P4; per-minute price estimated from token pricing')
ON CONFLICT (layer, provider, model) DO NOTHING;

COMMENT ON TABLE speech.catalog_entry IS 'Global voice provider catalog (STT/TTS/LLM/realtime): list prices and certification, operator-editable.';
