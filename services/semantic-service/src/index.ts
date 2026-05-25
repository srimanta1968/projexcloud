import { main } from './app';

// Only run main() when invoked as the binary entrypoint, not when imported
// as a library (other services + tests import buildApp/registerRoutes here).
if (require.main === module) {
  main().catch((err) => {
    console.error('[semantic-service] fatal startup error:', err);
    process.exit(1);
  });
}

export { buildApp } from './app';
export { registerRoutes } from './routes';
