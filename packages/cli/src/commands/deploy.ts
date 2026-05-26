/**
 * P9 / E5 — `projex deploy` (FR-CLI-5).
 *
 * Packages the current app dir → POSTs to the hosted MCP's deploy
 * endpoint → polls for status. Rollback (AC-10) is enforced server-side:
 * the migration runner snapshots the pool state pre-deploy and restores
 * on any migration failure. The CLI's job is to surface the deploy_id,
 * stream status, and exit non-zero on failure.
 *
 * Local packaging is intentionally minimal: collect every file the user
 * staged via `git ls-files` (or all non-ignored files if git is absent),
 * read into a manifest with sha256 + content. We DON'T tarball + upload
 * binary blobs in this v1 — the hosted side accepts a JSON manifest +
 * fetches blobs via signed URLs in the follow-up. v1 is good enough for
 * a small-app end-to-end demo (AC-4, AC-10).
 */

import { existsSync, readFileSync, statSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, relative, sep, posix } from 'node:path';
import { execSync } from 'node:child_process';
import { readStoredAuth } from './login';

export interface DeployInput {
  env: 'trial' | 'staging' | 'prod';
  appDir: string;
  appName?: string;
  hostedUrl?: string;
  apiKey?: string;
  /** Skip the POST; print the would-be payload + exit 0. */
  dryRun?: boolean;
  /** Poll until terminal status. Default true. */
  watch?: boolean;
  watchIntervalMs?: number;
  watchTimeoutMs?: number;
}

interface FileManifestEntry {
  path: string;
  size: number;
  sha256: string;
}

interface DeployPayload {
  app_name: string;
  env: 'trial' | 'staging' | 'prod';
  manifest: FileManifestEntry[];
  client_version: string;
}

export interface DeployResult {
  command: 'projex deploy';
  status: 'queued' | 'started' | 'in-progress' | 'success' | 'failed' | 'dry-run';
  env: 'trial' | 'staging' | 'prod';
  app_name: string;
  deploy_id?: string;
  url?: string;
  duration_ms?: number;
  rollback?: boolean;
  error?: string;
  manifest_file_count: number;
  manifest_total_bytes: number;
}

const IGNORE_DIRS = new Set([
  'node_modules', '.git', '.next', '.turbo', 'dist', 'build', 'coverage',
  '.cache', '.pnpm-store', '.vercel',
]);
const IGNORE_FILES = new Set(['.DS_Store']);
const IGNORE_EXTS = new Set(['.log', '.tmp']);

function listFiles(root: string): string[] {
  // Prefer git ls-files (respects .gitignore); fall back to walk.
  try {
    const stdout = execSync('git ls-files', { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    return stdout.split(/\r?\n/).filter((l) => l.length > 0);
  } catch {
    // Walk fallback
    const out: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.isDirectory()) {
          if (IGNORE_DIRS.has(entry.name)) continue;
          walk(join(dir, entry.name));
        } else if (entry.isFile()) {
          if (IGNORE_FILES.has(entry.name)) continue;
          const ext = entry.name.replace(/^.*(\.[^.]+)$/, '$1');
          if (IGNORE_EXTS.has(ext)) continue;
          const rel = relative(root, join(dir, entry.name)).split(sep).join(posix.sep);
          out.push(rel);
        }
      }
    };
    walk(root);
    return out;
  }
}

function buildManifest(root: string): FileManifestEntry[] {
  const files = listFiles(root);
  return files
    .map((path) => {
      const abs = join(root, path);
      if (!existsSync(abs)) return null;
      const st = statSync(abs);
      if (!st.isFile()) return null;
      const buf = readFileSync(abs);
      return {
        path,
        size: st.size,
        sha256: createHash('sha256').update(buf).digest('hex'),
      };
    })
    .filter((e): e is FileManifestEntry => e !== null);
}

function deriveAppName(appDir: string, override?: string): string {
  if (override) return override;
  const pkgPath = join(appDir, 'package.json');
  if (existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { name?: string };
      if (pkg.name) return pkg.name;
    } catch {
      // Fall through to dir basename
    }
  }
  return relative(join(appDir, '..'), appDir);
}

export async function runDeploy(input: DeployInput): Promise<DeployResult> {
  const appName = deriveAppName(input.appDir, input.appName);
  const manifest = buildManifest(input.appDir);
  const totalBytes = manifest.reduce((sum, f) => sum + f.size, 0);

  const payload: DeployPayload = {
    app_name: appName,
    env: input.env,
    manifest,
    client_version: '0.1.0',
  };

  if (input.dryRun) {
    return {
      command: 'projex deploy',
      status: 'dry-run',
      env: input.env,
      app_name: appName,
      manifest_file_count: manifest.length,
      manifest_total_bytes: totalBytes,
    };
  }

  const stored = readStoredAuth();
  const hostedUrl = (input.hostedUrl ?? stored.hosted_url ?? process.env.PROJEX_HOSTED_MCP)?.replace(/\/$/, '');
  const apiKey = input.apiKey ?? stored.api_key ?? process.env.PROJEX_API_KEY;
  if (!hostedUrl || !apiKey) {
    throw new Error(
      'projex deploy needs a hosted URL + API key. Run `projex login` or pass --hosted-url + --api-key.',
    );
  }

  const t0 = Date.now();
  let initResp: Response;
  try {
    initResp = await fetch(`${hostedUrl}/deploy`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-projex-api-key': apiKey },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(parseInt(process.env.PROJEX_DEPLOY_TIMEOUT_MS ?? '60000', 10)),
    });
  } catch (e) {
    return {
      command: 'projex deploy',
      status: 'failed',
      env: input.env,
      app_name: appName,
      duration_ms: Date.now() - t0,
      manifest_file_count: manifest.length,
      manifest_total_bytes: totalBytes,
      error: `deploy POST failed: ${(e as Error).message}`,
    };
  }
  if (!initResp.ok) {
    const text = await initResp.text();
    return {
      command: 'projex deploy',
      status: 'failed',
      env: input.env,
      app_name: appName,
      duration_ms: Date.now() - t0,
      manifest_file_count: manifest.length,
      manifest_total_bytes: totalBytes,
      error: `deploy POST returned ${initResp.status}: ${text.slice(0, 400)}`,
    };
  }
  const body = (await initResp.json()) as {
    deploy_id: string;
    status: 'queued' | 'started' | 'in-progress' | 'success' | 'failed';
    url?: string;
    rollback?: boolean;
    error?: string;
  };

  if (input.watch === false || body.status === 'success' || body.status === 'failed') {
    return {
      command: 'projex deploy',
      status: body.status,
      env: input.env,
      app_name: appName,
      deploy_id: body.deploy_id,
      url: body.url,
      duration_ms: Date.now() - t0,
      rollback: body.rollback,
      error: body.error,
      manifest_file_count: manifest.length,
      manifest_total_bytes: totalBytes,
    };
  }

  // Poll until terminal.
  const intervalMs = input.watchIntervalMs ?? 2000;
  const timeoutMs = input.watchTimeoutMs ?? 5 * 60 * 1000;
  const deadline = t0 + timeoutMs;
  let last = body;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, intervalMs));
    try {
      const pollResp = await fetch(`${hostedUrl}/deploy/${body.deploy_id}`, {
        headers: { 'x-projex-api-key': apiKey },
        signal: AbortSignal.timeout(15000),
      });
      if (!pollResp.ok) continue;
      last = (await pollResp.json()) as typeof body;
      if (last.status === 'success' || last.status === 'failed') break;
    } catch {
      // Transient poll failure — keep trying until timeout.
    }
  }

  return {
    command: 'projex deploy',
    status: last.status,
    env: input.env,
    app_name: appName,
    deploy_id: last.deploy_id,
    url: last.url,
    duration_ms: Date.now() - t0,
    rollback: last.rollback,
    error: last.error,
    manifest_file_count: manifest.length,
    manifest_total_bytes: totalBytes,
  };
}
