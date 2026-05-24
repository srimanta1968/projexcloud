import { main } from './app';

main().catch((err) => {
  console.error('[semantic-service] fatal startup error:', err);
  process.exit(1);
});

export { buildApp } from './app';
export { registerRoutes } from './routes';
