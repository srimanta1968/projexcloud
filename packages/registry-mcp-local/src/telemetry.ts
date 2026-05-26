/**
 * P9 / E3 — local MCP telemetry (FR-MCP-L6).
 *
 * OFF by default. Opt-in via `projex telemetry on` which writes
 * `{ enabled: true }` to ~/.projex/config.json. When enabled, ships
 * anonymous tool-call counters (no args, no payloads) to the hosted
 * MCP's /telemetry endpoint once per UTC day.
 *
 * Counters live in ~/.projex/cache/telemetry-counters.json. Reset on
 * successful upload.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';

interface TelemetryConfig {
  enabled?: boolean;
  device_id?: string;
}

interface Counters {
  day_utc: string;
  tools: Record<string, number>;
}

function projexHome(): string {
  return process.env.PROJEX_HOME ?? join(homedir(), '.projex');
}

function configPath(): string {
  return join(projexHome(), 'config.json');
}

function countersPath(): string {
  return join(projexHome(), 'cache', 'telemetry-counters.json');
}

function loadConfig(): TelemetryConfig {
  const p = configPath();
  if (!existsSync(p)) return {};
  try {
    return JSON.parse(readFileSync(p, 'utf8')) as TelemetryConfig;
  } catch {
    return {};
  }
}

function saveConfig(cfg: TelemetryConfig): void {
  const p = configPath();
  if (!existsSync(dirname(p))) mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(cfg, null, 2), { encoding: 'utf8' });
}

export function isTelemetryEnabled(): boolean {
  return loadConfig().enabled === true;
}

export function setTelemetry(enabled: boolean): { enabled: boolean; device_id?: string; path: string } {
  const cfg = loadConfig();
  cfg.enabled = enabled;
  if (enabled && !cfg.device_id) {
    cfg.device_id = `d-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  }
  saveConfig(cfg);
  return { enabled, device_id: cfg.device_id, path: configPath() };
}

function todayUtc(): string {
  return new Date().toISOString().slice(0, 10);
}

function loadCounters(): Counters {
  const p = countersPath();
  if (!existsSync(p)) return { day_utc: todayUtc(), tools: {} };
  try {
    const c = JSON.parse(readFileSync(p, 'utf8')) as Counters;
    if (c.day_utc !== todayUtc()) {
      return { day_utc: todayUtc(), tools: {} };
    }
    return c;
  } catch {
    return { day_utc: todayUtc(), tools: {} };
  }
}

function saveCounters(c: Counters): void {
  const p = countersPath();
  if (!existsSync(dirname(p))) mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(c), { encoding: 'utf8' });
}

/** Increment a tool counter. No-op when telemetry is off. */
export function bumpTool(tool: string): void {
  if (!isTelemetryEnabled()) return;
  const c = loadCounters();
  c.tools[tool] = (c.tools[tool] ?? 0) + 1;
  saveCounters(c);
}

export interface UploadResult {
  action: 'uploaded' | 'no-op' | 'disabled' | 'no-host' | 'failed';
  http_status?: number;
  error?: string;
  tools?: Record<string, number>;
}

/** Fire-and-forget daily upload. Resets counters on 2xx. */
export async function maybeUploadDaily(opts: { hostedUrl?: string } = {}): Promise<UploadResult> {
  if (!isTelemetryEnabled()) return { action: 'disabled' };
  const hostedUrl = (opts.hostedUrl ?? process.env.PROJEX_HOSTED_MCP)?.replace(/\/$/, '');
  if (!hostedUrl) return { action: 'no-host' };
  const counters = loadCounters();
  if (Object.keys(counters.tools).length === 0) return { action: 'no-op' };
  const cfg = loadConfig();

  try {
    const res = await fetch(`${hostedUrl}/telemetry/local`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        device_id: cfg.device_id,
        day_utc: counters.day_utc,
        tools: counters.tools,
        client: '@projexlight/registry-mcp-local',
      }),
      signal: AbortSignal.timeout(parseInt(process.env.PROJEX_HOSTED_TIMEOUT_MS ?? '10000', 10)),
    });
    if (!res.ok) return { action: 'failed', http_status: res.status };
    saveCounters({ day_utc: todayUtc(), tools: {} });
    return { action: 'uploaded', http_status: res.status, tools: counters.tools };
  } catch (e) {
    return { action: 'failed', error: (e as Error).message };
  }
}
