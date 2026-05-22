import { Kafka, KafkaConfig, Producer, Consumer, ConsumerConfig, EachMessagePayload } from 'kafkajs';

/**
 * @projexlight/kafka-runtime - kafkajs wrapper for Redpanda/Kafka.
 *
 * The host service calls `initKafka({brokers})` once at startup. SDK code
 * that needs to publish (sdk-meter emit) imports `getProducer()`; consumers
 * (meter-collector, audit fanout) use `createConsumer(groupId, topics)`.
 *
 * Per P1-Foundation-Spine §9.2, topics are partitioned by `tenant_id`.
 */

let _kafka: Kafka | null = null;
let _producer: Producer | null = null;
const _consumers: Consumer[] = [];

export function initKafka(config: KafkaConfig): Kafka {
  if (_kafka) return _kafka;
  _kafka = new Kafka({
    clientId: process.env.KAFKA_CLIENT_ID || 'projex-platform',
    ...config,
  });
  return _kafka;
}

export function getKafka(): Kafka {
  if (!_kafka) {
    throw new Error('[kafka-runtime] not initialized - call initKafka() at startup');
  }
  return _kafka;
}

/**
 * Returns the shared producer, connecting on first call. Idempotent — the
 * second caller gets the same instance after the connection settles.
 */
export async function getProducer(): Promise<Producer> {
  if (_producer) return _producer;
  const producer = getKafka().producer({
    allowAutoTopicCreation: true,
    idempotent: true,
    transactionalId: undefined,
    maxInFlightRequests: 5,
  });
  await producer.connect();
  _producer = producer;
  return producer;
}

/**
 * Publishes a single message to a topic. Convenience over getProducer().send.
 * `key` becomes the partition key (`tenant_id` for usage events).
 */
export async function publishMessage(topic: string, key: string, value: string): Promise<void> {
  const producer = await getProducer();
  await producer.send({
    topic,
    messages: [{ key, value }],
  });
}

export type MessageHandler = (msg: EachMessagePayload) => Promise<void>;

/**
 * Creates and starts a consumer for the given group + topics. Returns the
 * consumer instance so the host can stop() it on shutdown.
 */
export async function createConsumer(
  groupId: string,
  topics: string[],
  onMessage: MessageHandler,
  cfg?: Partial<ConsumerConfig>,
): Promise<Consumer> {
  const consumer = getKafka().consumer({
    groupId,
    sessionTimeout: 30_000,
    ...cfg,
  });
  await consumer.connect();
  for (const topic of topics) {
    await consumer.subscribe({ topic, fromBeginning: false });
  }
  await consumer.run({
    eachMessage: async (payload) => {
      try {
        await onMessage(payload);
      } catch (err) {
        console.error(`[kafka-runtime] handler threw on ${payload.topic}:${payload.partition}@${payload.message.offset}`, err);
      }
    },
  });
  _consumers.push(consumer);
  return consumer;
}

/**
 * Graceful shutdown — disconnects producer and every registered consumer.
 */
export async function closeKafka(): Promise<void> {
  try {
    if (_producer) {
      await _producer.disconnect();
      _producer = null;
    }
    for (const c of _consumers) {
      try { await c.disconnect(); } catch (e) { /* ignore */ }
    }
    _consumers.length = 0;
    _kafka = null;
  } catch (err) {
    console.error('[kafka-runtime] close error', err);
  }
}

export type { Kafka, KafkaConfig, Producer, Consumer, EachMessagePayload };
