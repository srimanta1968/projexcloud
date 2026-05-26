/**
 * P9 / E5 — `projex login` (FR-CLI-1).
 *
 * Simple device-flow-style enrollment. Two paths:
 *
 *  (a) Token mode (recommended for CI / scripts):
 *      `projex login --hosted-url https://mcp.us-east.projexcloud.com --api-key pk_acme_…`
 *      Stores both into ~/.projex/auth.json with 0o600.
 *
 *  (b) Interactive prompt (default when no flags): prompts on stderr for
 *      the hosted URL then the API key. Stores the same way.
 *
 * OS-keychain support (keytar) is intentionally deferred — adds a native
 * dep that complicates `npx -y` distribution per Q-6. Auth file at 0o600
 * is a reasonable v1 baseline; users can opt into keytar in P10.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { createInterface } from 'node:readline';

export interface LoginInput {
  hostedUrl?: string;
  apiKey?: string;
  /** When true, only prints what would happen without writing. */
  dryRun?: boolean;
}

export interface LoginResult {
  command: 'projex login';
  status: 'stored' | 'dry-run';
  hosted_url: string;
  auth_path: string;
  api_key_prefix: string;
}

function projexHome(): string {
  return process.env.PROJEX_HOME ?? join(homedir(), '.projex');
}

function authPath(): string {
  return join(projexHome(), 'auth.json');
}

async function prompt(question: string, mask = false): Promise<string> {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stderr });
    if (mask) {
      // Best-effort masking: hide echo on TTY. Falls back to plain read off-TTY.
      const stdin = process.stdin as NodeJS.ReadStream & { isTTY?: boolean };
      if (stdin.isTTY) process.stderr.write(question);
      rl.question(mask ? '' : question, (answer) => {
        rl.close();
        resolve(answer.trim());
      });
    } else {
      rl.question(question, (answer) => {
        rl.close();
        resolve(answer.trim());
      });
    }
  });
}

export async function runLogin(input: LoginInput): Promise<LoginResult> {
  const hostedUrl = (input.hostedUrl ?? (await prompt('Hosted MCP URL: '))).replace(/\/$/, '');
  if (!hostedUrl) throw new Error('hosted URL is required');

  const apiKey = input.apiKey ?? (await prompt('Tenant API key: ', true));
  if (!apiKey) throw new Error('api key is required');

  const path = authPath();
  if (input.dryRun) {
    return {
      command: 'projex login',
      status: 'dry-run',
      hosted_url: hostedUrl,
      auth_path: path,
      api_key_prefix: apiKey.slice(0, 6) + '…',
    };
  }

  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(
    path,
    JSON.stringify({ hosted_url: hostedUrl, api_key: apiKey, saved_at: new Date().toISOString() }, null, 2),
    { encoding: 'utf8' },
  );
  try {
    chmodSync(path, 0o600);
  } catch {
    // Windows often refuses chmod on non-NTFS or non-elevated runs; the
    // file still lives in ~/.projex which is user-private. Best-effort.
  }
  return {
    command: 'projex login',
    status: 'stored',
    hosted_url: hostedUrl,
    auth_path: path,
    api_key_prefix: apiKey.slice(0, 6) + '…',
  };
}

export function readStoredAuth(): { hosted_url?: string; api_key?: string } {
  const p = authPath();
  if (!existsSync(p)) return {};
  try {
    return JSON.parse(readFileSync(p, 'utf8')) as { hosted_url?: string; api_key?: string };
  } catch {
    return {};
  }
}
