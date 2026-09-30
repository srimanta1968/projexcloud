-- sdk-voice-agent ClickHouse schema (VA·E10 · TK-4520): voice analytics.
-- Applied on gateway boot by bootstrapVoiceClickHouseSchema (sha256-tracked, forward-only).

-- One row per answered turn, from the runtime's Kafka topic voice.turn.metrics.v1. Latencies
-- only — never transcript text.
CREATE TABLE IF NOT EXISTS voice.turn_metrics (
  at                DateTime64(3, 'UTC'),
  tenant_id         LowCardinality(String),
  call_id           String,
  agent_id          String,
  agent_version_id  String,
  is_test           UInt8,
  turn_index        UInt32,
  tier              LowCardinality(String),
  model             LowCardinality(String),
  stt_ms            Nullable(UInt32),
  ttft_ms           Nullable(UInt32),
  ttfa_ms           Nullable(UInt32),
  llm_ms            UInt32,
  interrupted       UInt8,
  tool_calls        UInt16,
  tool_errors       UInt16,
  llm_failed        UInt8,
  failed_over       Array(LowCardinality(String))
) ENGINE = MergeTree
PARTITION BY toYYYYMM(at)
ORDER BY (tenant_id, at, call_id)
TTL toDateTime(at) + INTERVAL 180 DAY;

-- One row per finished call, written when the call completes (sdk-voice-agent onCallEnded).
-- ReplacingMergeTree on version: a re-reported completion replaces the earlier row.
CREATE TABLE IF NOT EXISTS voice.call_facts (
  call_id             String,
  tenant_id           LowCardinality(String),
  agent_id            String,
  agent_version_id    String,
  direction           LowCardinality(String),
  is_test             UInt8,
  status              LowCardinality(String),
  disposition         LowCardinality(String),
  started_at          DateTime64(3, 'UTC'),
  ended_at            DateTime64(3, 'UTC'),
  duration_s          UInt32,
  turns               UInt32,
  agent_turns         UInt32,
  interrupted_turns   UInt32,
  stt_ms_p50          Nullable(Float64),
  ttft_ms_p50         Nullable(Float64),
  ttfa_ms_p50         Nullable(Float64),
  ttfa_ms_p95         Nullable(Float64),
  tool_calls          UInt32,
  tool_errors         UInt32,
  provider_errors     UInt32,
  degraded_layers     Array(LowCardinality(String)),
  degraded_providers  Array(LowCardinality(String)),
  cost_usd            Nullable(Float64),
  cost_source         LowCardinality(String),
  version             UInt64
) ENGINE = ReplacingMergeTree(version)
PARTITION BY toYYYYMM(ended_at)
ORDER BY (tenant_id, call_id)
TTL toDateTime(ended_at) + INTERVAL 400 DAY;
