/**
 * P9 / E5 — `projex logs` (FR-CLI-6).
 *
 * Streams logs from the deployed app over the hosted MCP's SSE log
 * endpoint. `--tail` keeps the connection open; without it, prints the
 * last N lines (default 200) and exits.
 *
 * Output shape: NDJSON when --json, otherwise one-line-per-event human
 * format `2026-05-26T12:34:56Z [level] message`.
 */

import { readStoredAuth } from './login';

export interface LogsInput {
  appName: string;
  hostedUrl?: string;
  apiKey?: string;
  tail?: boolean;
  limit?: number;
  json?: boolean;
  /** Test-only: stop after this many events. */
  maxEvents?: number;
}

export interface LogsResult {
  command: 'projex logs';
  app_name: string;
  event_count: number;
  status: 'finished' | 'tailing-interrupted' | 'failed';
  error?: string;
}

interface LogEvent {
  ts: string;
  level: 'info' | 'warn' | 'error' | 'debug';
  message: string;
  meta?: Record<string, unknown>;
}

function fmt(e: LogEvent, json: boolean): string {
  if (json) return JSON.stringify(e);
  return `${e.ts} [${e.level}] ${e.message}`;
}

export async function runLogs(input: LogsInput): Promise<LogsResult> {
  const stored = readStoredAuth();
  const hostedUrl = (input.hostedUrl ?? stored.hosted_url ?? process.env.PROJEX_HOSTED_MCP)?.replace(/\/$/, '');
  const apiKey = input.apiKey ?? stored.api_key ?? process.env.PROJEX_API_KEY;
  if (!hostedUrl || !apiKey) {
    throw new Error(
      'projex logs needs a hosted URL + API key. Run `projex login` or pass --hosted-url + --api-key.',
    );
  }

  const limit = input.limit ?? 200;
  const url = input.tail
    ? `${hostedUrl}/apps/${encodeURIComponent(input.appName)}/logs/stream`
    : `${hostedUrl}/apps/${encodeURIComponent(input.appName)}/logs?limit=${limit}`;

  let res: Response;
  try {
    res = await fetch(url, {
      headers: { 'x-projex-api-key': apiKey, accept: input.tail ? 'text/event-stream' : 'application/json' },
      signal: input.tail ? undefined : AbortSignal.timeout(30000),
    });
  } catch (e) {
    return { command: 'projex logs', app_name: input.appName, event_count: 0, status: 'failed', error: (e as Error).message };
  }
  if (!res.ok) {
    return {
      command: 'projex logs',
      app_name: input.appName,
      event_count: 0,
      status: 'failed',
      error: `hosted MCP returned ${res.status}`,
    };
  }

  let count = 0;

  if (!input.tail) {
    const body = (await res.json()) as { events: LogEvent[] };
    for (const e of body.events) {
      process.stdout.write(fmt(e, !!input.json) + '\n');
      count++;
    }
    return { command: 'projex logs', app_name: input.appName, event_count: count, status: 'finished' };
  }

  // SSE tail mode
  if (!res.body) {
    return { command: 'projex logs', app_name: input.appName, event_count: 0, status: 'failed', error: 'no SSE body' };
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        if (!line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (!data) continue;
        try {
          const e = JSON.parse(data) as LogEvent;
          process.stdout.write(fmt(e, !!input.json) + '\n');
          count++;
          if (input.maxEvents && count >= input.maxEvents) {
            await reader.cancel();
            return { command: 'projex logs', app_name: input.appName, event_count: count, status: 'finished' };
          }
        } catch {
          // Non-JSON heartbeat line — skip.
        }
      }
    }
  } catch (e) {
    return { command: 'projex logs', app_name: input.appName, event_count: count, status: 'tailing-interrupted', error: (e as Error).message };
  }
  return { command: 'projex logs', app_name: input.appName, event_count: count, status: 'finished' };
}
