#!/usr/bin/env node
/**
 * P9 / E1.F3 — sdk-capability CLI.
 *
 * Subcommands:
 *   scaffold [--dir <path>] [--out <path>] [--pool <placement>]
 *     Generate a starter sdk-capability.json from the package at --dir (default cwd).
 *     Writes to --out (default <dir>/sdk-capability.json).
 *
 *   validate [--dir <path>]
 *     Validate the sdk-capability.json under --dir against schema 1.0 + lints.
 *     Exit 0 on pass, 1 on any error.
 *
 * Used by:
 *   - SDK owners locally before raising a manifest PR
 *   - The CI gate (scripts/registry-validate.ts wraps `validate` over every package)
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { scaffoldManifest } from './scaffold';
import { validateManifest } from './validator';
import { PoolPlacement } from './types';

interface ParsedArgs {
  subcommand: string;
  flags: Record<string, string | true>;
  positional: string[];
}

function parseArgs(argv: string[]): ParsedArgs {
  const [, , subcommand = 'help', ...rest] = argv;
  const flags: Record<string, string | true> = {};
  const positional: string[] = [];
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a.startsWith('--')) {
      const name = a.slice(2);
      const next = rest[i + 1];
      if (next && !next.startsWith('--')) {
        flags[name] = next;
        i++;
      } else {
        flags[name] = true;
      }
    } else {
      positional.push(a);
    }
  }
  return { subcommand, flags, positional };
}

function printHelp(): void {
  process.stdout.write(`sdk-capability — SDK capability-manifest tooling (P9 / E1)

Usage:
  sdk-capability scaffold [--dir <path>] [--out <path>] [--pool <placement>]
  sdk-capability validate [--dir <path>]
  sdk-capability help

Subcommands:
  scaffold   Generate a starter sdk-capability.json from a package's source.
  validate   Validate an existing sdk-capability.json against schema 1.0 + lints.

Common flags:
  --dir <path>    Path to the package directory (default: current working dir).
  --out <path>    Where to write the scaffolded manifest (default: <dir>/sdk-capability.json).
  --pool <name>   Pool placement for scaffold; one of:
                  admin, app, evidence, global-catalog, warehouse, vector, olap.
                  Default: app.

Exit codes:
  0  Success.
  1  Validation failed, or scaffold failed.
  2  Bad arguments.
`);
}

function cmdScaffold(args: ParsedArgs): number {
  const dir = resolve(String(args.flags.dir ?? process.cwd()));
  const out = resolve(String(args.flags.out ?? join(dir, 'sdk-capability.json')));
  const pool = args.flags.pool ? (String(args.flags.pool) as PoolPlacement) : undefined;
  try {
    const manifest = scaffoldManifest({ packageDir: dir, pool_placement: pool });
    writeFileSync(out, JSON.stringify(manifest, null, 2) + '\n');
    process.stdout.write(
      `Wrote scaffolded manifest to ${out}\n` +
        `Next: edit the TBD: placeholders (summary, scenarios, compliance) and run:\n` +
        `  sdk-capability validate --dir ${dir}\n`,
    );
    return 0;
  } catch (err) {
    process.stderr.write(`scaffold failed: ${(err as Error).message}\n`);
    return 1;
  }
}

function cmdValidate(args: ParsedArgs): number {
  const dir = resolve(String(args.flags.dir ?? process.cwd()));
  const path = join(dir, 'sdk-capability.json');
  let raw: string;
  try {
    raw = readFileSync(path, 'utf-8');
  } catch {
    process.stderr.write(`MANIFEST_MISSING: ${path}\n`);
    return 1;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    process.stderr.write(`MANIFEST_INVALID_JSON: ${path}: ${(err as Error).message}\n`);
    return 1;
  }
  const r = validateManifest(parsed);
  if (r.ok) {
    process.stdout.write(`OK: ${path}\n`);
    return 0;
  }
  process.stderr.write(`MANIFEST_INVALID: ${path}\n`);
  for (const e of r.errors) process.stderr.write(`  - ${e}\n`);
  return 1;
}

function main(): void {
  const args = parseArgs(process.argv);
  switch (args.subcommand) {
    case 'scaffold':
      process.exit(cmdScaffold(args));
    case 'validate':
      process.exit(cmdValidate(args));
    case 'help':
    case '--help':
    case '-h':
      printHelp();
      process.exit(0);
    default:
      process.stderr.write(`unknown subcommand: ${args.subcommand}\n`);
      printHelp();
      process.exit(2);
  }
}

main();
