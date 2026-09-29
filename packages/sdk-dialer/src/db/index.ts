import fs from 'fs';
import path from 'path';

/**
 * Path to this package's SQL migrations, handed to the migration runner in a
 * consuming app's boot sequence:
 *
 *   import { migrationsDir as dialerMigrations } from '@projexlight/sdk-dialer';
 *   await runMigrations([ ..., { sdk: 'sdk-dialer', dir: dialerMigrations } ]);
 *
 * Resolves whether running from dist/ (built) or src/ (ts-node/tests).
 */
const candidates = [
  path.join(__dirname, 'migrations'),
  path.resolve(__dirname, '..', '..', 'src', 'db', 'migrations'),
];

export const migrationsDir: string = candidates.find((d) => fs.existsSync(d)) ?? candidates[0];
