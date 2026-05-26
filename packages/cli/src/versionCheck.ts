/**
 * P9 / E5 — newer-version warning (FR-CLI-8).
 *
 * Best-effort, non-blocking. Hits the npm registry at most once per 24h
 * (cached in ~/.projex/cache/version-check.json). Prints a one-line
 * warning to stderr if a newer @projexlight/cli is available. Never
 * auto-installs (per FR-CLI-8: "never auto-installs without consent").
 *
 * Opt-out via env PROJEX_SKIP_VERSION_CHECK=1.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';

const PKG_NAME = '@projexlight/cli';
const CURRENT_VERSION = '0.1.0';
const CHECK_TTL_MS = 24 * 3600 * 1000;

interface CacheShape {
  checked_at: string;
  latest_version?: string;
  error?: string;
}

function cachePath(): string {
  const home = process.env.PROJEX_HOME ?? join(homedir(), '.projex');
  return join(home, 'cache', 'version-check.json');
}

function readCache(): CacheShape | null {
  const p = cachePath();
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, 'utf8')) as CacheShape;
  } catch {
    return null;
  }
}

function writeCache(c: CacheShape): void {
  const p = cachePath();
  if (!existsSync(dirname(p))) mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(c), { encoding: 'utf8' });
}

function isNewer(a: string, b: string): boolean {
  const pa = a.split('.').map((n) => parseInt(n, 10));
  const pb = b.split('.').map((n) => parseInt(n, 10));
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const da = pa[i] ?? 0;
    const db = pb[i] ?? 0;
    if (da > db) return true;
    if (da < db) return false;
  }
  return false;
}

export async function maybeWarnNewerVersion(): Promise<void> {
  const cache = readCache();
  if (cache && Date.now() - new Date(cache.checked_at).getTime() < CHECK_TTL_MS) {
    if (cache.latest_version && isNewer(cache.latest_version, CURRENT_VERSION)) {
      process.stderr.write(
        `[projex] update available: ${CURRENT_VERSION} → ${cache.latest_version} (npm i -g ${PKG_NAME})\n`,
      );
    }
    return;
  }

  try {
    const res = await fetch(`https://registry.npmjs.org/${encodeURIComponent(PKG_NAME)}/latest`, {
      signal: AbortSignal.timeout(3000),
      headers: { accept: 'application/json' },
    });
    if (!res.ok) {
      writeCache({ checked_at: new Date().toISOString(), error: `status ${res.status}` });
      return;
    }
    const body = (await res.json()) as { version?: string };
    const latest = body.version;
    writeCache({ checked_at: new Date().toISOString(), latest_version: latest });
    if (latest && isNewer(latest, CURRENT_VERSION)) {
      process.stderr.write(
        `[projex] update available: ${CURRENT_VERSION} → ${latest} (npm i -g ${PKG_NAME})\n`,
      );
    }
  } catch {
    writeCache({ checked_at: new Date().toISOString(), error: 'fetch failed' });
  }
}
