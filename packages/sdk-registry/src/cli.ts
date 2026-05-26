#!/usr/bin/env node
/**
 * P9 / E2 — registry-build CLI.
 *
 * Scans the workspace, validates every sdk-capability.json, builds a
 * normalized catalog with derived dependency graph, writes it to
 * dist/registry.catalog.json (relative to --out-dir, default cwd/dist).
 *
 * Embedding index (registry.embeddings.bin) lands in E2.F3; this CLI
 * currently emits the catalog only.
 *
 * Usage:
 *   sdk-registry-build [--repo <path>] [--out-dir <path>] [--strict]
 *
 *   --repo <path>      Repo root to scan (default: process.cwd())
 *   --out-dir <path>   Where to write the catalog (default: <repo>/dist)
 *   --strict           Exit non-zero if any manifest MISSING/INVALID
 *                      (default: skip them but still produce a catalog)
 *   --no-embed         Skip the bge-small embedding index build
 *                      (default: embed and write registry.embeddings.{bin,meta.json})
 *   --built-at <iso>   Pin built_at for deterministic CI rebuilds
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { scanWorkspace } from './scanner';
import { buildCatalog, serializeCatalog, catalogContentHash } from './catalog';
import {
  buildEmbeddingIndex,
  createEmbedder,
  embeddingsContentHash,
  writeEmbeddingIndex,
  planEmbeddings,
} from './embeddings';

function parseArgs() {
  const args = process.argv.slice(2);
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith('--')) {
      const name = a.slice(2);
      const next = args[i + 1];
      if (next && !next.startsWith('--')) {
        flags[name] = next;
        i++;
      } else {
        flags[name] = true;
      }
    }
  }
  return flags;
}

async function main() {
  const flags = parseArgs();
  const repo = resolve(String(flags.repo ?? process.cwd()));
  const outDir = resolve(String(flags['out-dir'] ?? join(repo, 'dist')));
  const strict = flags.strict === true;
  const skipEmbed = flags['no-embed'] === true;
  const built_at = typeof flags['built-at'] === 'string' ? String(flags['built-at']) : undefined;

  process.stdout.write(`Scanning ${repo} ...\n`);
  const scan = scanWorkspace({ repoRoot: repo });

  const ok = scan.filter((s) => s.status === 'OK');
  const bad = scan.filter((s) => s.status !== 'OK');

  process.stdout.write(
    `  ${scan.length} SDK(s): ${ok.length} OK, ${bad.filter((s) => s.status === 'MISSING').length} MISSING, ${bad.filter((s) => s.status === 'INVALID' || s.status === 'INVALID_JSON').length} INVALID\n`,
  );

  if (strict && bad.length > 0) {
    process.stderr.write(`\nStrict mode: ${bad.length} manifest(s) failed validation:\n`);
    for (const b of bad) {
      process.stderr.write(`  ${b.status}: ${b.path}\n`);
      for (const e of b.errors) process.stderr.write(`    - ${e}\n`);
    }
    process.exit(1);
  }

  const catalog = buildCatalog({ scan, built_at });
  mkdirSync(outDir, { recursive: true });
  const catalogPath = join(outDir, 'registry.catalog.json');
  writeFileSync(catalogPath, serializeCatalog(catalog));

  const hash = catalogContentHash(catalog);
  process.stdout.write(`Wrote ${catalogPath}\n`);
  process.stdout.write(
    `  sdks=${catalog.counts.sdks}  endpoints=${catalog.counts.endpoints}  events_produced=${catalog.counts.events_produced}  events_consumed_unmatched=${catalog.counts.events_consumed_unmatched}  scenarios=${catalog.counts.scenarios}\n`,
  );
  process.stdout.write(`  content_hash=${hash}\n`);

  if (catalog.counts.events_consumed_unmatched > 0) {
    process.stdout.write(
      `  (warn: ${catalog.counts.events_consumed_unmatched} consumed event(s) have no producer in the catalog — may be external or unauthored upstream)\n`,
    );
  }

  if (skipEmbed) {
    process.stdout.write(`Skipping embedding build (--no-embed).\n`);
    return;
  }

  const planned = planEmbeddings(catalog);
  if (planned.length === 0) {
    process.stdout.write(`No records to embed (catalog is empty). Skipping embedding build.\n`);
    return;
  }

  process.stdout.write(`\nBuilding embedding index (model=bge-small-en-v1.5 q8, dim=384) ...\n`);
  process.stdout.write(`  ${planned.length} records to embed (${catalog.counts.sdks} summaries + ${catalog.counts.scenarios} scenarios)\n`);
  const startMs = Date.now();
  const embedder = await createEmbedder();
  const idx = await buildEmbeddingIndex(catalog, embedder);
  const elapsedMs = Date.now() - startMs;

  const binPath = join(outDir, 'registry.embeddings.bin');
  const metaPath = join(outDir, 'registry.embeddings.meta.json');
  writeEmbeddingIndex(idx, binPath, metaPath);
  process.stdout.write(`Wrote ${binPath} + ${metaPath}\n`);
  process.stdout.write(`  embeddings_hash=${embeddingsContentHash(idx)}\n`);
  process.stdout.write(`  elapsed=${elapsedMs}ms (~${Math.round(elapsedMs / planned.length)}ms/record)\n`);
}

main().catch((err) => {
  process.stderr.write(`registry-build failed: ${(err && err.stack) || err}\n`);
  process.exit(2);
});
