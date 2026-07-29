import fs from 'fs';
import path from 'path';

/**
 * Path to this package's SQL migrations, handed to the migration runner in a
 * consuming app's boot sequence:
 *
 *   import { migrationsDir as sourceRecordMigrations } from '@projexlight/sdk-import';
 *   await runMigrations([ ..., { sdk: 'sdk-import', dir: sourceRecordMigrations } ]);
 *
 * Migrations run at Fastify BOOT only — never on module import and never from
 * data-access code. Exporting the directory (not a self-executing runner) is what
 * keeps that guarantee: importing this package touches no database.
 *
 * Resolves whether running from dist/ (built) or src/ (ts-node/tests).
 */
const candidates = [
  path.join(__dirname, 'migrations'),
  path.resolve(__dirname, '..', '..', 'src', 'db', 'migrations'),
];

export const migrationsDir: string = candidates.find((d) => fs.existsSync(d)) ?? candidates[0];
