import fs from 'fs';
import path from 'path';

/**
 * Resolves this SDK's migrations directory. Works from TS source
 * (`src/db/migrations`) or compiled dist (`dist/db/`) — tsc only compiles
 * `.ts`, so dist has no `migrations/`; we fall back to the source path.
 */
const candidates = [
  path.join(__dirname, 'migrations'),
  path.resolve(__dirname, '..', '..', 'src', 'db', 'migrations'),
];

export const migrationsDir: string = candidates.find((d) => fs.existsSync(d)) ?? candidates[0];
