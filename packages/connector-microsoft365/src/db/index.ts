import fs from 'fs';
import path from 'path';
const candidates = [path.join(__dirname, 'migrations'), path.resolve(__dirname, '..', '..', 'src', 'db', 'migrations')];
export const migrationsDir: string = candidates.find((d) => fs.existsSync(d)) ?? candidates[0];
