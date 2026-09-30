import { initKafka, publishMessage } from '@projexlight/kafka-runtime';
import { log } from '../log';

/**
 * Per-turn metrics to Kafka (VA·E1 · TK-4467), one message per answered turn on
 * VOICE_TURN_TOPIC (default voice.turn.metrics.v1), keyed by tenant_id (P1 §9.2 partitioning).
 * The analytics consumer (ClickHouse voice_turn_metrics, TK-4520) reads it.
 *
 * Metrics only — latency, model, tier, barge-in, tool outcomes, failover state. Never the
 * transcript text: that is written once, at call end, to Postgres through the control plane.
 *
 * Fire-and-forget: a Kafka error is logged (rate-limited) and never slows or breaks a call.
 * Without KAFKA_BROKERS the sink is a no-op.
 */

export interface TurnEvent {
  call_id: string;
  tenant_id: string;
  agent_id: string;
  agent_version_id: string;
  is_test: boolean;
  turn_index: number;
  tier: 'fast' | 'complex';
  model: string | null;
  /** Caller end of speech -> final transcript. */
  stt_ms: number | null;
  /** LLM request -> first token. */
  ttft_ms: number | null;
  /** Caller end of speech -> first agent audio (voice-to-voice). */
  ttfa_ms: number | null;
  llm_ms: number;
  interrupted: boolean;
  tool_calls: number;
  tool_errors: number;
  llm_failed: boolean;
  /** Layers running on their secondary credential (TK-4465). */
  failed_over: string[];
  at: string;
}

export interface TurnEventSink {
  publish(e: TurnEvent): void;
}

export const noopTurnSink: TurnEventSink = { publish: () => undefined };

export function kafkaTurnSink(env: NodeJS.ProcessEnv = process.env): TurnEventSink {
  const brokers = (env.KAFKA_BROKERS || '').split(',').map((b) => b.trim()).filter(Boolean);
  if (brokers.length === 0 || env.KAFKA_ENABLED === 'false') {
    log.info('turn metrics: no KAFKA_BROKERS, not publishing');
    return noopTurnSink;
  }
  initKafka({ brokers, clientId: env.KAFKA_CLIENT_ID || 'voice-runtime' });
  const topic = env.VOICE_TURN_TOPIC || 'voice.turn.metrics.v1';
  let lastErrorLogAt = 0;
  log.info('turn metrics: publishing to Kafka', { topic, brokers: brokers.length });
  return {
    publish(e) {
      publishMessage(topic, e.tenant_id, JSON.stringify(e)).catch((err: Error) => {
        if (Date.now() - lastErrorLogAt < 60_000) return;
        lastErrorLogAt = Date.now();
        log.warn('turn metrics publish failed (logged once a minute)', { topic, error: err.message });
      });
    },
  };
}
