import dotenv from 'dotenv';
dotenv.config();

/**
 * Hosting-service configuration. Per ProjectStructure-v3.1, services hold
 * deployment config; SDKs read narrow env vars they own.
 */
export const config = {
  nodeEnv: process.env.NODE_ENV || 'development',
  port: parseInt(process.env.PORT || '3000', 10),
  appName: process.env.APP_NAME || 'projex-api-gateway',

  db: {
    host: process.env.DB_HOST || 'localhost',
    port: parseInt(process.env.DB_PORT || '5432', 10),
    database: process.env.DB_NAME || 'projexcloud_db',
    user: process.env.DB_USER || 'postgres',
    password: process.env.DB_PASSWORD || 'postgres',
    ssl: process.env.DB_SSL === 'true',
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
};
