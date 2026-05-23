#!/usr/bin/env node
/**
 * meter-codegen CLI. Scans `--root` for @meter() decorators and emits a
 * registration file at `--out`. Defaults mirror the platform convention:
 * scan ./src, write ./src/codegen/meter.gen.ts.
 */
import path from 'path';
import { emitMeterGen, scanPackage, type MeterDecoratorEntry } from './index';

const args: string[] = process.argv.slice(2);
let root: string = 'src';
let out: string = path.join(process.cwd(), 'src', 'codegen', 'meter.gen.ts');

for (let i = 0; i < args.length; i++) {
  if (args[i] === '--root') root = args[++i];
  else if (args[i] === '--out') out = args[++i];
}

const entries: MeterDecoratorEntry[] = scanPackage(path.resolve(process.cwd(), root));
emitMeterGen(entries, path.resolve(process.cwd(), out));
console.log(`[meter-codegen] wrote ${entries.length} entries to ${out}`);
