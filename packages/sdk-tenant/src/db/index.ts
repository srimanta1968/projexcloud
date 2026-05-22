import fs from 'fs';
import path from 'path';

/**
 * Resolves this SDK's migrations directory. Works whether loaded from TS
 * source (`src/db/migrations`) or compiled dist (`dist/db/`) — TS only
 * compiles `.ts` files so dist/ has no `migrations/` folder. We fall back
 * to the source path so production deploys still find the SQL.
 */
const candidates = [
  path.join(__dirname, 'migrations'),                                      // src layout
  path.resolve(__dirname, '..', '..', 'src', 'db', 'migrations'),          // dist layout
];

export const migrationsDir: string = candidates.find((d) => fs.existsSync(d)) ?? candidates[0];
