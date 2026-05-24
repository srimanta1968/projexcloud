import Fastify, { type FastifyInstance } from 'fastify';
import { initPool } from '@projexlight/db-runtime';
import { registerRoutes } from './routes';

export interface AppOptions {
  databaseUrl?: string;
}

export async function buildApp(opts: AppOptions = {}): Promise<FastifyInstance> {
  const databaseUrl = opts.databaseUrl ?? process.env.SEMANTIC_SERVICE_DB_URL ?? process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error(
      '[semantic-service] no database URL configured. Set SEMANTIC_SERVICE_DB_URL or DATABASE_URL.',
    );
  }
  initPool({ connectionString: databaseUrl });

  const fastify = Fastify({
    logger: { level: process.env.LOG_LEVEL ?? 'info' },
    disableRequestLogging: true,
  });

  await registerRoutes(fastify);

  return fastify;
}

export async function main(): Promise<void> {
  const fastify = await buildApp();
  const port = parseInt(process.env.PORT ?? '8082', 10);
  const host = process.env.HOST ?? '0.0.0.0';
  await fastify.listen({ port, host });
  console.log(`[semantic-service] listening on ${host}:${port}`);

  const shutdown = async (sig: string) => {
    console.log(`[semantic-service] received ${sig}; shutting down`);
    try { await fastify.close(); } catch (err) { console.error(err); }
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}
