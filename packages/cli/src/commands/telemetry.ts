/**
 * P9 / E5 — `projex telemetry on|off|status` (FR-MCP-L6 surface).
 */

import { isTelemetryEnabled, setTelemetry } from '@projexlight/registry-mcp-local';
import { join } from 'node:path';
import { homedir } from 'node:os';

export interface TelemetryResult {
  enabled: boolean;
  device_id?: string;
  path: string;
}

export function runTelemetry(action: 'on' | 'off' | 'status'): TelemetryResult {
  const path = join(process.env.PROJEX_HOME ?? join(homedir(), '.projex'), 'config.json');
  if (action === 'status') {
    return { enabled: isTelemetryEnabled(), path };
  }
  return setTelemetry(action === 'on');
}
