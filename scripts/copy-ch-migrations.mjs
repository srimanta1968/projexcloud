// Copies ClickHouse *.ch.sql migration files from src/db/ch_migrations to
// dist/db/ch_migrations. `tsc` does not copy non-TS assets, so without this
// step the dist build ships an empty ch_migrations dir and the CH bootstrapper
// finds no migrations on boot (tables never get created).
//
// Run from a package directory (cwd) as part of that package's build script:
//   "build": "tsc && node ../../scripts/copy-ch-migrations.mjs"
//
// Cross-platform (pure Node fs) so it works on the Windows dev machine.
import { existsSync, mkdirSync, readdirSync, copyFileSync } from 'node:fs';
import { join } from 'node:path';

const srcDir = join(process.cwd(), 'src', 'db', 'ch_migrations');
const destDir = join(process.cwd(), 'dist', 'db', 'ch_migrations');

if (!existsSync(srcDir)) {
  console.log(`[copy-ch-migrations] no source dir at ${srcDir}, skipping`);
  process.exit(0);
}

mkdirSync(destDir, { recursive: true });

let copied = 0;
for (const file of readdirSync(srcDir)) {
  if (file.endsWith('.ch.sql')) {
    copyFileSync(join(srcDir, file), join(destDir, file));
    copied += 1;
  }
}

console.log(`[copy-ch-migrations] copied ${copied} .ch.sql file(s) to ${destDir}`);
