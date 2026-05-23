/**
 * Verifies that importing @projexlight/connector-slack registers the
 * 'slack' adapter with the sdk-connectors framework registry.
 *
 * Mirrors the adapterRegistry side-effect contract documented in
 * packages/sdk-connectors/src/services/connectorsService.ts.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getAdapter, listAdapterKinds } from '@projexlight/sdk-connectors';
import slackAdapter from '../src/index';

test('connector-slack registers a "slack" adapter at import time', () => {
  const found = getAdapter('slack');
  assert.ok(found, 'expected getAdapter("slack") to return the registered adapter');
  assert.equal(found?.kind, 'slack');
  assert.ok(listAdapterKinds().includes('slack'));
});

test('slackAdapter exports the required ConnectorAdapter shape', () => {
  assert.equal(slackAdapter.kind, 'slack');
  assert.ok(Array.isArray(slackAdapter.tools));
  const toolNames = slackAdapter.tools.map((t) => t.tool_name).sort();
  assert.deepEqual(toolNames, [
    'slack.channel.list',
    'slack.message.post',
    'slack.thread.reply',
    'slack.user.lookup',
  ]);
});

test('slackAdapter.callTool returns NotConfigured when SLACK_BOT_TOKEN is unset', async () => {
  const prev = process.env.SLACK_BOT_TOKEN;
  delete process.env.SLACK_BOT_TOKEN;
  try {
    const result = await slackAdapter.callTool(
      {
        install_id: '00000000-0000-0000-0000-000000000001',
        tenant_id: '00000000-0000-0000-0000-000000000002',
        connector_kind: 'slack',
        display_name: null,
        status: 'active',
        credential_ref: null,
        vendor_account_id: null,
        installed_by: '00000000-0000-0000-0000-000000000003',
        installed_at: new Date(),
        uninstalled_at: null,
      },
      'slack.message.post',
      { channel: '#general', text: 'hi' },
    );
    assert.equal(result.ok, false);
    assert.equal(result.error, 'NotConfigured');
  } finally {
    if (prev !== undefined) process.env.SLACK_BOT_TOKEN = prev;
  }
});
