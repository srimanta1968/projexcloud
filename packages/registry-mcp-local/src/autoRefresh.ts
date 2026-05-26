/**
 * P9 / E3 — local MCP cache auto-refresh (FR-MCP-L3).
 *
 * On boot, checks the age of ~/.projex/cache/registry.catalog.json. If older
 * than `intervalHours` (default 24), kicks off a background fetch from the
 * hosted MCP's GET /registry/catalog endpoint. ETag-conditional so a no-op
 * round-trip is cheap when nothing changed.
 *
 * Best-effort: a failed refresh never blocks server startup. The user can
 * also force one with `projex registry refresh`.
 */

import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';

export interface RefreshOptions {
  /** Hours; default 24 (per PRD: "daily background pull"). */
  intervalHours?: number;
  /** Override the catalog path; defaults to ~/.projex/cache/registry.catalog.json. */
  catalogPath?: string;
  /** Hosted endpoint base; defaults to PROJEX_HOSTED_MCP. */
  hostedUrl?: string;
  /** Forced refresh ignores the interval check. */
  force?: boolean;
}

export interface RefreshResult {
  action: 'refreshed' | 'not-modified' | 'too-fresh' | 'skipped-no-host' | 'failed';
  age_ms?: number;
  catalog_path?: string;
  error?: string;
  http_status?: number;
}

function projexHome(): string {
  return process.env.PROJEX_HOME ?? join(homedir(), '.projex');
}

function defaultCatalogPath(): string {
  return join(projexHome(), 'cache', 'registry.catalog.json');
}

function readEtag(catalogPath: string): string | undefined {
  const metaPath = catalogPath + '.meta.json';
  if (!existsSync(metaPath)) return undefined;
  try {
    return (JSON.parse(readFileSync(metaPath, 'utf8')) as { etag?: string }).etag;
  } catch {
    return undefined;
  }
}

function writeEtag(catalogPath: string, etag: string | null): void {
  const metaPath = catalogPath + '.meta.json';
  writeFileSync(metaPath, JSON.stringify({ etag, refreshed_at: new Date().toISOString() }), { encoding: 'utf8' });
}

export async function maybeRefreshCatalog(opts: RefreshOptions = {}): Promise<RefreshResult> {
  const catalogPath = opts.catalogPath ?? defaultCatalogPath();
  const hostedUrl = (opts.hostedUrl ?? process.env.PROJEX_HOSTED_MCP)?.replace(/\/$/, '');
  if (!hostedUrl) {
    return { action: 'skipped-no-host', catalog_path: catalogPath };
  }

  const intervalHours = opts.intervalHours ?? 24;
  const intervalMs = intervalHours * 3600 * 1000;

  let age_ms = Infinity;
  if (existsSync(catalogPath)) {
    age_ms = Date.now() - statSync(catalogPath).mtimeMs;
  }
  if (!opts.force && age_ms < intervalMs) {
    return { action: 'too-fresh', age_ms, catalog_path: catalogPath };
  }

  try {
    const etag = readEtag(catalogPath);
    const headers: Record<string, string> = {};
    if (etag) headers['if-none-match'] = etag;
    const apiKey = process.env.PROJEX_API_KEY;
    if (apiKey) headers['x-projex-api-key'] = apiKey;

    const res = await fetch(`${hostedUrl}/registry/catalog`, {
      headers,
      signal: AbortSignal.timeout(parseInt(process.env.PROJEX_HOSTED_TIMEOUT_MS ?? '20000', 10)),
    });

    if (res.status === 304) {
      // Still mark the file as refreshed-now so the next interval check
      // doesn't immediately re-pull.
      writeEtag(catalogPath, etag ?? null);
      return { action: 'not-modified', catalog_path: catalogPath, http_status: 304 };
    }
    if (!res.ok) {
      return { action: 'failed', http_status: res.status, error: await res.text().then((t) => t.slice(0, 200)) };
    }
    const body = (await res.json()) as { catalog_entries: unknown };
    const dir = dirname(catalogPath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(catalogPath, JSON.stringify(body.catalog_entries, null, 2), { encoding: 'utf8' });
    writeEtag(catalogPath, res.headers.get('etag'));
    return { action: 'refreshed', catalog_path: catalogPath, http_status: res.status };
  } catch (e) {
    return { action: 'failed', error: (e as Error).message };
  }
}

/** Fire-and-forget background refresh. Logs to stderr so stdio MCP traffic stays clean. */
export function backgroundRefresh(opts: RefreshOptions = {}): void {
  void maybeRefreshCatalog(opts).then((r) => {
    if (r.action === 'failed' || r.action === 'refreshed') {
      process.stderr.write(JSON.stringify({ kind: 'registry-mcp-local.refresh', ...r }) + '\n');
    }
  });
}
