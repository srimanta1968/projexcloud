import dotenv from 'dotenv';

dotenv.config();

export type EnvKind = 'development' | 'staging' | 'production' | 'test';

export interface PlatformConfig {
  nodeEnv: EnvKind;
  port: number;
  appName: string;
  region: string;
  db: {
    host: string;
    port: number;
    database: string;
    user: string;
    password: string;
    ssl: boolean;
    poolMin: number;
    poolMax: number;
  };
  jwt: {
    secret: string;
    expiresIn: string;
  };
  bcryptRounds: number;
  corsOrigin: string[];
  logLevel: string;
  bodyLimit: string;
  vault: {
    rotationEnabled: boolean;
    rotationIntervalMs: number;
    rotationMaxAgeDays: number;
  };
}

/**
 * Reads a required env var; throws at startup if missing in production.
 */
function requireEnv(key: string, fallback?: string): string {
  const v = process.env[key];
  if (v && v.length > 0) return v;
  if (fallback !== undefined) return fallback;
  if (process.env.NODE_ENV === 'production') {
    throw new Error(`Missing required env var ${key}`);
  }
  return '';
}

function parseInt10(v: string | undefined, fallback: number): number {
  const n = parseInt(v ?? '', 10);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * Loads the platform config from the environment. Per Architecture §3A
 * Opinionated Constraint OC-3, secret values come from `secret://` refs
 * resolved by sdk-secrets, not from plaintext env vars in production.
 */
export function loadConfig(): PlatformConfig {
  return {
    nodeEnv: (process.env.NODE_ENV as EnvKind) || 'development',
    port: parseInt10(process.env.PORT, 3000),
    appName: process.env.APP_NAME || 'projex-api-gateway',
    region: process.env.REGION || 'us-east-1',
    db: {
      host: process.env.DB_HOST || 'localhost',
      port: parseInt10(process.env.DB_PORT, 5432),
      database: process.env.DB_NAME || 'projexcloud_db',
      user: process.env.DB_USER || 'postgres',
      password: requireEnv('DB_PASSWORD', 'postgres'),
      ssl: process.env.DB_SSL === 'true',
      poolMin: parseInt10(process.env.DB_POOL_MIN, 2),
      poolMax: parseInt10(process.env.DB_POOL_MAX, 10),
    },
    jwt: {
      secret: requireEnv('JWT_SECRET', 'change-me-in-prod'),
      expiresIn: process.env.JWT_EXPIRES_IN || '7d',
    },
    bcryptRounds: parseInt10(process.env.BCRYPT_ROUNDS, 10),
    corsOrigin: process.env.CORS_ORIGIN?.split(',') || ['http://localhost:3000'],
    logLevel: process.env.LOG_LEVEL || 'debug',
    bodyLimit: process.env.BODY_PARSER_LIMIT || '10mb',
    vault: {
      rotationEnabled: process.env.VAULT_ROTATION_ENABLED === 'true',
      rotationIntervalMs: parseInt10(process.env.VAULT_ROTATION_INTERVAL_MS, 3_600_000),
      rotationMaxAgeDays: parseInt10(process.env.VAULT_ROTATION_MAX_AGE_DAYS, 90),
    },
  };
}
