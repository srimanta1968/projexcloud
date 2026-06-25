import fs from 'fs';
import path from 'path';

/** Resolves this SDK's migrations directory (TS source or compiled dist). */
const candidates = [
  path.join(__dirname, 'migrations'),
  path.resolve(__dirname, '..', '..', 'src', 'db', 'migrations'),
];

export const migrationsDir: string = candidates.find((d) => fs.existsSync(d)) ?? candidates[0];
