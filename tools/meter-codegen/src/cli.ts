#!/usr/bin/env node
import path from 'path';
import { emitMeterGen, scanPackage } from './index';

const args = process.argv.slice(2);
let root = 'src';
let out = path.join(process.cwd(), 'src', 'codegen', 'meter.gen.ts');

for (let i = 0; i < args.length; i++) {
  if (args[i] === '--root') root = args[++i];
  else if (args[i] === '--out') out = args[++i];
}

const entries = scanPackage(path.resolve(process.cwd(), root));
emitMeterGen(entries, path.resolve(process.cwd(), out));
console.log(`[meter-codegen] wrote ${entries.length} entries to ${out}`);
