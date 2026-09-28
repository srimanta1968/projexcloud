import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
// Load .env from the monorepo root, not from services/api-gateway's cwd.
// ts-node-dev resolves cwd to the package dir, so a bare dotenv.config()
// would miss the root .env where DB/Redis/Kafka/LLM credentials live.
dotenv.config({ path: path.resolve(__dirname, '../../../.env') });

/**
 * Hosting-service configuration. Per ProjectStructure-v3.1, services hold
 * deployment config; SDKs read narrow env vars they own.
 */
export const config = {
  nodeEnv: process.env.NODE_ENV || 'development',
  // GATEWAY_PORT is a gateway-specific override so `pnpm run dev` (turbo runs the
  // gateway AND the Next.js portals together) can pin the gateway off the portals'
  // ports without a bare PORT bleeding into `next dev` (which also reads PORT).
  // Falls back to PORT, then 3000. Set GATEWAY_PORT in the root .env for a stable
  // local port across restarts.
  port: parseInt(process.env.GATEWAY_PORT || process.env.PORT || '3000', 10),
  appName: process.env.APP_NAME || 'projex-api-gateway',

  db: {
    host: process.env.DB_HOST || 'localhost',
    port: parseInt(process.env.DB_PORT || '5432', 10),
    database: process.env.DB_NAME || 'projexcloud_db',
    user: process.env.DB_USER || 'postgres',
    password: process.env.DB_PASSWORD || 'postgres',
    ssl: process.env.DB_SSL === 'true',
    // When DB_SSL is on, VERIFY the server certificate. It used to skip certificate
    // checks entirely, i.e. encrypted but open to a man-in-the-middle on the DB link.
    // DB_SSL_CA points at a PEM bundle for a private CA (e.g. the RDS bundle);
    // DB_SSL_REJECT_UNAUTHORIZED=false is the explicit, visible opt-out for a
    // self-signed dev database. No deployment sets DB_SSL today, so nothing changes
    // until someone turns TLS on — and then it is verified by default.
    sslRejectUnauthorized: process.env.DB_SSL_REJECT_UNAUTHORIZED !== 'false',
    sslCaPath: process.env.DB_SSL_CA || undefined,
    poolMin: parseInt(process.env.DB_POOL_MIN || '2', 10),
    poolMax: parseInt(process.env.DB_POOL_MAX || '10', 10),
  },

  corsOrigin: process.env.CORS_ORIGIN?.split(',') || ['http://localhost:3000'],
  logLevel: process.env.LOG_LEVEL || 'debug',
  bodyLimit: parseInt(process.env.BODY_PARSER_LIMIT || '10485760', 10),

  redis: {
    enabled: process.env.REDIS_ENABLED !== 'false',
    host: process.env.REDIS_HOST || 'localhost',
    port: parseInt(process.env.REDIS_PORT || '6379', 10),
    password: process.env.REDIS_PASSWORD || undefined,
    db: parseInt(process.env.REDIS_DB || '0', 10),
    routeCacheTtlMs: parseInt(process.env.ROUTE_CACHE_TTL_MS || '300000', 10),
  },

  kafka: {
    enabled: process.env.KAFKA_ENABLED !== 'false',
    brokers: (process.env.KAFKA_BROKERS || 'localhost:9092').split(','),
    clientId: process.env.KAFKA_CLIENT_ID || 'projex-api-gateway',
    usageTopic: process.env.USAGE_EVENTS_TOPIC || 'usage.events.v1',
  },

  clickhouse: {
    enabled: process.env.CLICKHOUSE_ENABLED === 'true',
    url: process.env.CLICKHOUSE_URL || 'http://localhost:8123',
    username: process.env.CLICKHOUSE_USERNAME || 'default',
    password: process.env.CLICKHOUSE_PASSWORD || '',
    database: process.env.CLICKHOUSE_DATABASE || 'meter',
  },
};

/**
 * TLS options for the gateway's Postgres pool: `false` when DB_SSL is off, otherwise
 * certificate-verifying TLS (optionally against the DB_SSL_CA bundle).
 *
 * @throws Error when DB_SSL_CA is set but unreadable — failing at boot beats silently
 *   connecting without the CA the operator asked for.
 */
export function dbSslOptions(): false | { rejectUnauthorized: boolean; ca?: string } {
  if (!config.db.ssl) return false;
  const ca = config.db.sslCaPath ? fs.readFileSync(config.db.sslCaPath, 'utf8') : undefined;
  return { rejectUnauthorized: config.db.sslRejectUnauthorized, ...(ca ? { ca } : {}) };
}
