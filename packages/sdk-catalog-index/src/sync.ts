import { createHash } from 'node:crypto';
import { scanWorkspace, type ScanResult } from '@projexlight/sdk-registry';
import type { SdkCapabilityManifest } from '@projexlight/sdk-capability';
import { embed } from './embedder';
import {
  getSdkHash,
  upsertSdk,
  replaceSdkChildren,
  bumpSyncVersion,
  type EndpointRow,
  type EmbeddingUpsert,
} from './store';

/**
 * Catalog auto-sync (TK-3460 / TK-3461).
 *
 * Reuses the sdk-registry scanner to walk every sdk-capability.json, content-hash
 * each manifest, and upsert ONLY changed SDKs into catalog.* — re-embedding their
 * cards with the shared bge-small model. Idempotent and incremental: a no-op repo
 * re-sync touches zero rows. Intended to run in the api-gateway boot sequence
 * right after runMigrations().
 */

export interface SyncOptions {
  /** Absolute monorepo root (dir containing packages/). */
  repoRoot?: string;
  topDirs?: string[];
}

export interface SyncSummary {
  scanned: number;
  changed: number;
  skipped: number;
  invalid: number;
  version: number;
}

interface ManifestEndpoint {
  method: string;
  path: string;
  description?: string;
  kind?: string;
  request_schema?: unknown;
  response_schema?: unknown;
  auth_scopes?: string[];
}

function contentHash(manifest: SdkCapabilityManifest): string {
  return createHash('sha256').update(JSON.stringify(manifest)).digest('hex');
}

function tierOf(manifest: SdkCapabilityManifest): 'foundation' | 'domain' {
  return (manifest.tags ?? []).includes('foundation') ? 'foundation' : 'domain';
}

/** Build the relational endpoint rows + the embeddable cards for one manifest. */
function buildChildren(manifest: SdkCapabilityManifest): {
  endpoints: EndpointRow[];
  cards: Array<Omit<EmbeddingUpsert, 'vector'>>;
} {
  const name = manifest.name;
  const endpoints: EndpointRow[] = [];
  const cards: Array<Omit<EmbeddingUpsert, 'vector'>> = [];

  // SDK summary card.
  cards.push({
    ref_kind: 'sdk',
    ref_id: name,
    card: `${name}\n${(manifest.tags ?? []).join(' ')}\n${manifest.summary}`,
  });

  // Endpoint rows + cards (+ ingest cards for data-entry endpoints).
  const eps = (manifest.provides?.endpoints ?? []) as unknown as ManifestEndpoint[];
  for (const ep of eps) {
    if (!ep.method || !ep.path) continue;
    const kind = ep.kind ?? 'query';
    endpoints.push({
      sdk_name: name,
      method: ep.method,
      path: ep.path,
      kind,
      description: ep.description ?? null,
      request_schema: ep.request_schema ?? null,
      response_schema: ep.response_schema ?? null,
      auth_scopes: ep.auth_scopes ?? [],
    });
    cards.push({
      ref_kind: 'endpoint',
      ref_id: `${name} ${ep.method} ${ep.path}`,
      card: `${ep.method} ${ep.path}\n${ep.description ?? ''}`,
    });
    if (kind === 'ingest' || kind === 'bulk') {
      cards.push({
        ref_kind: 'ingest',
        ref_id: `ingest:${name} ${ep.method} ${ep.path}`,
        card: `import/upload data via ${ep.method} ${ep.path}\n${ep.description ?? ''}`,
      });
    }
  }

  // Scenario cards (strongest discovery signal).
  for (const s of manifest.scenarios ?? []) {
    cards.push({
      ref_kind: 'scenario',
      ref_id: `${name}#${s.id}`,
      card: `${s.title}\n${s.when_to_use}\n${s.expected_outcome}`,
    });
  }

  return { endpoints, cards };
}

/** Run the incremental catalog sync. Returns a summary. */
export async function syncCatalog(opts: SyncOptions = {}): Promise<SyncSummary> {
  const repoRoot = opts.repoRoot ?? process.env.PROJEXCLOUD_REPO_ROOT ?? process.cwd();
  const results: ScanResult[] = scanWorkspace({ repoRoot, topDirs: opts.topDirs });

  let changed = 0;
  let skipped = 0;
  let invalid = 0;

  for (const r of results) {
    if (r.status !== 'OK' || !r.manifest) {
      if (r.status === 'INVALID' || r.status === 'INVALID_JSON') invalid++;
      continue;
    }
    const manifest = r.manifest;
    const hash = contentHash(manifest);

    const existing = await getSdkHash(manifest.name);
    if (existing === hash) {
      skipped++;
      continue;
    }

    await upsertSdk({
      name: manifest.name,
      version: manifest.version ?? null,
      summary: manifest.summary,
      tags: manifest.tags ?? [],
      tier: tierOf(manifest),
      pool_placement: (manifest as { pool_placement?: string }).pool_placement ?? null,
      content_hash: hash,
    });

    const { endpoints, cards } = buildChildren(manifest);
    const embeddings: EmbeddingUpsert[] = [];
    for (const c of cards) {
      embeddings.push({ ...c, vector: await embed(c.card) });
    }
    await replaceSdkChildren(manifest.name, endpoints, embeddings);
    changed++;
  }

  let version = 0;
  if (changed > 0) version = await bumpSyncVersion();

  const summary: SyncSummary = {
    scanned: results.length,
    changed,
    skipped,
    invalid,
    version,
  };
  console.log(`[sdk-catalog-index] sync: ${changed} changed, ${skipped} unchanged, ${invalid} invalid (v${version})`);
  return summary;
}
