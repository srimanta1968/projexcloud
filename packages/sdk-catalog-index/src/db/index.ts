import fs from 'node:fs';
import path from 'node:path';

/**
 * Path to this package's SQL migrations, handed to @projexlight/migration-runner
 * in the api-gateway boot sequence:
 *
 *   import { migrationsDir as catalogMigrations } from '@projexlight/sdk-catalog-index';
 *   await runMigrations([ ..., { sdk: 'sdk-catalog-index', dir: catalogMigrations } ]);
 *
 * Resolves whether running from dist/ (built) or src/ (ts-node/tests).
 */
const candidates = [
  path.join(__dirname, 'migrations'),
  path.resolve(__dirname, '..', '..', 'src', 'db', 'migrations'),
];

export const migrationsDir: string = candidates.find((d) => fs.existsSync(d)) ?? candidates[0];
