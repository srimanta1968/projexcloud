/**
 * Unit tests for the adapter registry. Connector packages call
 * registerAdapter() at import time so api-gateway can dispatch sync + tool
 * calls without hard-coding vendor packages. This file verifies the
 * registry's contract — register, lookup, list, idempotency.
 */
import { describe, expect, it, beforeEach } from 'vitest';
import {
  getAdapter,
  listAdapterKinds,
  registerAdapter,
} from '../src/services/connectorsService';
import type { ConnectorAdapter, InstallRecord, ToolDefinition } from '../src/models/connector.model';

function makeStubAdapter(kind: string, tools: ToolDefinition[] = []): ConnectorAdapter {
  return {
    kind,
    tools,
    async onInstall(_install: InstallRecord): Promise<void> { /* stub */ },
    async onUninstall(_install: InstallRecord): Promise<void> { /* stub */ },
    async sync(_install: InstallRecord) { return { records_synced: 0, conflicts: 0 }; },
    async callTool(_install: InstallRecord, tool_name: string) {
      return { ok: true, tool_name };
    },
  };
}

describe('adapter registry', () => {
  beforeEach(() => {
    // Clean slate per test by re-registering with empty arrays.
    // Note: registerAdapter is a Map.set under the hood so re-register
    // overwrites; we exploit that for isolation.
  });

  it('registerAdapter + getAdapter round-trip', () => {
    const stub = makeStubAdapter('test-vendor-1');
    registerAdapter(stub);
    expect(getAdapter('test-vendor-1')).toBe(stub);
  });

  it('getAdapter returns undefined for unknown kind', () => {
    expect(getAdapter('definitely-not-registered')).toBeUndefined();
  });

  it('re-registering same kind overwrites (last-write-wins)', () => {
    const v1 = makeStubAdapter('test-vendor-2', [{ tool_name: 'v1.thing', args_schema: {} }]);
    const v2 = makeStubAdapter('test-vendor-2', [{ tool_name: 'v2.thing', args_schema: {} }]);
    registerAdapter(v1);
    registerAdapter(v2);
    expect(getAdapter('test-vendor-2')).toBe(v2);
    expect(getAdapter('test-vendor-2')?.tools[0].tool_name).toBe('v2.thing');
  });

  it('listAdapterKinds returns every registered kind, sorted', () => {
    registerAdapter(makeStubAdapter('aaa-kind'));
    registerAdapter(makeStubAdapter('zzz-kind'));
    registerAdapter(makeStubAdapter('mmm-kind'));
    const kinds = listAdapterKinds();
    // The list contains everything we registered (plus possibly others
    // from earlier tests); just verify ours are present and sorted.
    expect(kinds).toContain('aaa-kind');
    expect(kinds).toContain('mmm-kind');
    expect(kinds).toContain('zzz-kind');
    expect(kinds.indexOf('aaa-kind')).toBeLessThan(kinds.indexOf('mmm-kind'));
    expect(kinds.indexOf('mmm-kind')).toBeLessThan(kinds.indexOf('zzz-kind'));
  });

  it('adapter tools array is preserved verbatim through register', () => {
    const tools: ToolDefinition[] = [
      { tool_name: 'foo.do', args_schema: { type: 'object' }, sku_required: 'foo.call', enabled_for_agents: true },
      { tool_name: 'foo.read', args_schema: { type: 'object' } },
    ];
    registerAdapter(makeStubAdapter('test-vendor-tools', tools));
    const got = getAdapter('test-vendor-tools');
    expect(got?.tools).toHaveLength(2);
    expect(got?.tools[0].tool_name).toBe('foo.do');
    expect(got?.tools[0].enabled_for_agents).toBe(true);
    expect(got?.tools[1].enabled_for_agents).toBeUndefined();
  });
});
