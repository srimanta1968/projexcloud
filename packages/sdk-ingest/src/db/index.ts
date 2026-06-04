import fs from 'node:fs';
import path from 'node:path';

/** Migrations path for @projexlight/migration-runner (resolves dist or src). */
const candidates = [
  path.join(__dirname, 'migrations'),
  path.resolve(__dirname, '..', '..', 'src', 'db', 'migrations'),
];

export const migrationsDir: string = candidates.find((d) => fs.existsSync(d)) ?? candidates[0];
