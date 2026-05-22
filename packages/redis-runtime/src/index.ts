import IORedis, { Redis, RedisOptions } from 'ioredis';

/**
 * @projexlight/redis-runtime - shared Redis client + pub/sub helpers.
 *
 * The host service calls `initRedis()` once at startup. SDK code that needs
 * a Redis-backed cache (sdk-pool-router, sdk-meter live counter, identity
 * projection hot store) imports `getRedis()` to use the shared client.
 *
 * For pub/sub callers must keep a dedicated subscriber connection — Redis
 * subscriber connections cannot also issue commands. Use `getSubscriber()`
 * for that.
 */

let _client: Redis | null = null;
let _subscriber: Redis | null = null;
let _opts: RedisOptions | null = null;

/**
 * Initialize the shared Redis client. Idempotent — calling again returns
 * the existing instance.
 */
export function initRedis(opts: RedisOptions): Redis {
  if (_client) return _client;
  _opts = opts;
  _client = new IORedis(opts);
  _client.on('error', (err) => console.error('[redis-runtime] client error', err));
  return _client;
}

/** Returns the initialized Redis client. Throws if `initRedis()` wasn't called. */
export function getRedis(): Redis {
  if (!_client) {
    throw new Error('[redis-runtime] client not initialized - call initRedis() at startup');
  }
  return _client;
}

/**
 * Returns a dedicated subscriber connection. Lazily duplicates the main
 * client's connection on first call (subscribers can't issue normal commands).
 */
export function getSubscriber(): Redis {
  if (_subscriber) return _subscriber;
  if (!_client || !_opts) {
    throw new Error('[redis-runtime] cannot create subscriber - client not initialized');
  }
  _subscriber = new IORedis(_opts);
  _subscriber.on('error', (err) => console.error('[redis-runtime] subscriber error', err));
  return _subscriber;
}

/**
 * Publishes a message on a channel. Returns the number of subscribers that
 * received the message (per Redis PUBLISH semantics).
 */
export async function publish(channel: string, message: string): Promise<number> {
  try {
    return await getRedis().publish(channel, message);
  } catch (err) {
    throw err;
  }
}

/**
 * Subscribes to a channel and invokes `handler` on every message. The handler
 * runs in the event loop; throwing inside it does not unsubscribe.
 */
export async function subscribe(channel: string, handler: (message: string) => void | Promise<void>): Promise<void> {
  const sub = getSubscriber();
  await sub.subscribe(channel);
  sub.on('message', (ch, msg) => {
    if (ch !== channel) return;
    try {
      const result = handler(msg);
      if (result instanceof Promise) {
        result.catch((err) => console.error(`[redis-runtime] subscribe handler threw on ${channel}`, err));
      }
    } catch (err) {
      console.error(`[redis-runtime] subscribe handler threw on ${channel}`, err);
    }
  });
}

/**
 * Closes the client and subscriber connections. Called on graceful shutdown.
 */
export async function closeRedis(): Promise<void> {
  try {
    if (_subscriber) {
      await _subscriber.quit();
      _subscriber = null;
    }
    if (_client) {
      await _client.quit();
      _client = null;
    }
  } catch (err) {
    console.error('[redis-runtime] close error', err);
  }
}

export type { Redis, RedisOptions };
