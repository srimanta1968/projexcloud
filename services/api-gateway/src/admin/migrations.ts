import fs from 'fs';
import path from 'path';

/**
 * Resolves this service's admin-ops-token migrations directory. Mirrors the
 * `migrationsDir` resolver each SDK package ships: works whether the gateway
 * runs from TS source or compiled dist (dist has no `migrations/` folder, so
 * we fall back to the src copy that ships in the image).
 */
const candidates = [
  path.join(__dirname, 'migrations'),
  path.resolve(__dirname, '..', '..', 'src', 'admin', 'migrations'),
];

export const adminOpsMigrationsDir: string =
  candidates.find((d) => fs.existsSync(d)) ?? candidates[0];
