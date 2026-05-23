import fs from 'fs';
import path from 'path';

/**
 * Resolves this SDK's migrations directory. Works whether loaded from TS
 * source or compiled dist — dist has no `migrations/` folder.
 */
const candidates = [
  path.join(__dirname, 'migrations'),
  path.resolve(__dirname, '..', '..', 'src', 'db', 'migrations'),
];

export const migrationsDir: string = candidates.find((d) => fs.existsSync(d)) ?? candidates[0];
