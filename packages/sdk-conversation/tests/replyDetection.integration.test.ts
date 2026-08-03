import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'crypto';
import { initPool, dataService, closeAllPools } from '@projexlight/db-runtime';

/**
 * Reply detection against a REAL Postgres, because every property this task claims lives
 * in SQL: the resolution queries, the CHECK constraints and the trigger that forces an
 * unmatched inbound to stay flagged. A mocked dataService would only prove the mock.
 *
 * Skips itself when no database is reachable, so a machine without the dev stack still
 * gets a green suite rather than a misleading red one.
 */

const PG = {
  host: process.env.TEST_PGHOST || 'localhost',
  port: Number(process.env.TEST_PGPORT || 5432),
  database: process.env.TEST_PGDATABASE || 'projexcloud_db',
  user: process.env.TEST_PGUSER || 'postgres',
  password: process.env.TEST_PGPASSWORD || 'postgres',
};

// Explicit opt-out. Unset (the CI default) means an unreachable database FAILS this
// suite rather than quietly passing it. See the catch block below.
const SKIP_DB_TESTS = process.env.SKIP_DB_TESTS === '1';
let dbUp = false;
const TENANT = randomUUID();

// Imported lazily: the module graph pulls in db-runtime, which must be initialised first.
let svc: typeof import('../src/services/replyDetection');

beforeAll(async () => {
  try {
    initPool({ primary: PG });
    await dataService.query('SELECT 1');
    await dataService.query(
      `SELECT 1 FROM conversation.message WHERE reply_link_state IS NOT NULL LIMIT 1`,
    );
    dbUp = true;
  } catch (err) {
    dbUp = false;
    // FAIL LOUD. A suite that cannot reach its schema has verified nothing, and a run
    // that reports green having verified nothing is worse than a red one: it is a false
    // all-clear that nobody investigates. Skipping remains available, but it must be
    // asked for explicitly and it then reports as SKIPPED rather than as PASSED.
    if (!SKIP_DB_TESTS) {
      throw new Error(
        '[db-gate] database or schema unavailable, so this suite cannot verify '
        + `anything: ${(err as Error).message}. `
        + 'Apply migrations first (MIGRATE_ONLY=1 on the gateway), or set '
        + 'SKIP_DB_TESTS=1 to skip these cases visibly instead of passing them silently.',
      );
    }
    return;
  }
  svc = await import('../src/services/replyDetection');
});

afterAll(async () => {
  if (!dbUp) return;
  await dataService.query(`DELETE FROM conversation.message WHERE tenant_id = $1::uuid`, [TENANT]);
  await dataService.query(`DELETE FROM conversation.thread WHERE tenant_id = $1::uuid`, [TENANT]);
  await closeAllPools();
});

async function newThread(purpose = 'reply detection fixture'): Promise<string> {
  const r = await dataService.one<{ thread_id: string }>(
    `INSERT INTO conversation.thread (tenant_id, subject_ref, purpose)
     VALUES ($1::uuid, $2, $3) RETURNING thread_id::text`,
    [TENANT, `lead:${randomUUID()}`, purpose],
  );
  return r!.thread_id;
}

async function outbound(opts: {
  thread_id: string;
  channel: string;
  occurred_at: string;
  provider_message_key?: string;
  provider_thread_key?: string;
}): Promise<string> {
  const r = await dataService.one<{ message_id: string }>(
    `INSERT INTO conversation.message
       (tenant_id, thread_id, channel, direction, body_ref, actor, occurred_at,
        delivery_state, provider_message_key, provider_thread_key)
     VALUES ($1::uuid, $2::uuid, $3, 'OUTBOUND', 'vault:out', 'persona:rep', $4::timestamptz,
             'SENT', $5, $6)
     RETURNING message_id::text`,
    [
      TENANT,
      opts.thread_id,
      opts.channel,
      opts.occurred_at,
      opts.provider_message_key ?? null,
      opts.provider_thread_key ?? null,
    ],
  );
  return r!.message_id;
}

async function inbound(opts: {
  thread_id: string;
  channel: string;
  occurred_at: string;
}): Promise<string> {
  const r = await dataService.one<{ message_id: string }>(
    `INSERT INTO conversation.message
       (tenant_id, thread_id, channel, direction, body_ref, actor, occurred_at, delivery_state)
     VALUES ($1::uuid, $2::uuid, $3, 'INBOUND', 'vault:in', 'contact:them', $4::timestamptz,
             'RECEIVED')
     RETURNING message_id::text`,
    [TENANT, opts.thread_id, opts.channel, opts.occurred_at],
  );
  return r!.message_id;
}

async function stateOf(message_id: string) {
  return dataService.one<{
    reply_link_state: string;
    reply_link_method: string | null;
    in_reply_to_message_id: string | null;
    reply_linked_at: Date | null;
  }>(
    `SELECT reply_link_state, reply_link_method, in_reply_to_message_id::text, reply_linked_at
       FROM conversation.message WHERE message_id = $1::uuid`,
    [message_id],
  );
}

const maybe = (name: string, fn: () => Promise<void>) =>
  it(name, async (ctx) => {
    // ctx.skip() reports the case as SKIPPED. A bare `return` reports it as PASSED,
    // which is indistinguishable from the assertions having actually run.
    if (!dbUp) { ctx.skip(); return; }
    await fn();
  });

describe('reply detection ladder (AC1, AC3)', () => {
  maybe('EMAIL: In-Reply-To naming our Message-ID links as proof', async () => {
    const t = await newThread();
    const parent = await outbound({
      thread_id: t,
      channel: 'EMAIL',
      occurred_at: '2026-08-01T09:00:00Z',
      provider_message_key: 'msgid-alpha@ours',
    });
    const reply = await inbound({ thread_id: t, channel: 'EMAIL', occurred_at: '2026-08-01T10:00:00Z' });

    const r = await svc.detectAndLinkReply({
      tenant_id: TENANT,
      message_id: reply,
      thread_id: t,
      channel: 'EMAIL',
      occurred_at: '2026-08-01T10:00:00Z',
      signals: { provider_in_reply_to_key: '<msgid-alpha@ours>' },
    });

    expect(r.linked).toBe(true);
    expect(r.parent_message_id).toBe(parent);
    expect(r.method).toBe('PROVIDER_REPLY_ID');
    expect(r.confidence).toBe('proof');
    const row = await stateOf(reply);
    expect(row!.reply_link_state).toBe('LINKED');
    expect(row!.in_reply_to_message_id).toBe(parent);
    expect(row!.reply_linked_at).not.toBeNull();
  });

  maybe('EMAIL: falls back to References when In-Reply-To matches nothing', async () => {
    const t = await newThread();
    const parent = await outbound({
      thread_id: t,
      channel: 'EMAIL',
      occurred_at: '2026-08-01T09:00:00Z',
      provider_message_key: 'msgid-beta@ours',
    });
    const reply = await inbound({ thread_id: t, channel: 'EMAIL', occurred_at: '2026-08-01T11:00:00Z' });

    const r = await svc.detectAndLinkReply({
      tenant_id: TENANT,
      message_id: reply,
      thread_id: t,
      channel: 'EMAIL',
      occurred_at: '2026-08-01T11:00:00Z',
      signals: {
        provider_in_reply_to_key: 'rewritten-by-client@theirs',
        provider_reference_keys: ['<root@theirs> <msgid-beta@ours>'],
      },
    });

    expect(r.linked).toBe(true);
    expect(r.parent_message_id).toBe(parent);
    expect(r.method).toBe('EMAIL_HEADER');
  });

  maybe('SOCIAL_DM: links by carrier thread key', async () => {
    const t = await newThread();
    const parent = await outbound({
      thread_id: t,
      channel: 'SOCIAL_DM',
      occurred_at: '2026-08-01T09:00:00Z',
      provider_thread_key: 'dm-convo-77',
    });
    const reply = await inbound({ thread_id: t, channel: 'SOCIAL_DM', occurred_at: '2026-08-01T09:30:00Z' });

    const r = await svc.detectAndLinkReply({
      tenant_id: TENANT,
      message_id: reply,
      thread_id: t,
      channel: 'SOCIAL_DM',
      occurred_at: '2026-08-01T09:30:00Z',
      signals: { provider_thread_key: 'dm-convo-77' },
    });

    expect(r.linked).toBe(true);
    expect(r.parent_message_id).toBe(parent);
    expect(r.method).toBe('PROVIDER_THREAD_KEY');
    expect(r.confidence).toBe('strong');
  });

  maybe('SMS: no threading signals at all — recency heuristic, marked as a guess', async () => {
    const t = await newThread();
    const parent = await outbound({
      thread_id: t,
      channel: 'SMS',
      occurred_at: '2026-08-01T09:00:00Z',
    });
    const reply = await inbound({ thread_id: t, channel: 'SMS', occurred_at: '2026-08-01T09:05:00Z' });

    const r = await svc.detectAndLinkReply({
      tenant_id: TENANT,
      message_id: reply,
      thread_id: t,
      channel: 'SMS',
      occurred_at: '2026-08-01T09:05:00Z',
    });

    expect(r.linked).toBe(true);
    expect(r.parent_message_id).toBe(parent);
    expect(r.method).toBe('CHANNEL_RECENCY');
    expect(r.confidence).toBe('heuristic');
  });

  maybe('recency never reaches past the window', async () => {
    const t = await newThread();
    await outbound({ thread_id: t, channel: 'SMS', occurred_at: '2026-01-01T09:00:00Z' });
    const reply = await inbound({ thread_id: t, channel: 'SMS', occurred_at: '2026-08-01T09:00:00Z' });

    const r = await svc.detectAndLinkReply({
      tenant_id: TENANT,
      message_id: reply,
      thread_id: t,
      channel: 'SMS',
      occurred_at: '2026-08-01T09:00:00Z',
    });
    expect(r.linked).toBe(false);
    expect(r.state).toBe('UNMATCHED');
  });

  maybe('recency never picks an outbound that happened AFTER the reply', async () => {
    const t = await newThread();
    await outbound({ thread_id: t, channel: 'SMS', occurred_at: '2026-08-01T12:00:00Z' });
    const reply = await inbound({ thread_id: t, channel: 'SMS', occurred_at: '2026-08-01T10:00:00Z' });

    const r = await svc.detectAndLinkReply({
      tenant_id: TENANT,
      message_id: reply,
      thread_id: t,
      channel: 'SMS',
      occurred_at: '2026-08-01T10:00:00Z',
    });
    expect(r.linked).toBe(false);
  });
});

describe('unmatched inbound is retained and flagged (AC4)', () => {
  maybe('an unresolvable reply survives as UNMATCHED and appears in the queue', async () => {
    const t = await newThread();
    const orphan = await inbound({ thread_id: t, channel: 'EMAIL', occurred_at: '2026-08-01T10:00:00Z' });

    const r = await svc.detectAndLinkReply({
      tenant_id: TENANT,
      message_id: orphan,
      thread_id: t,
      channel: 'EMAIL',
      occurred_at: '2026-08-01T10:00:00Z',
      signals: { provider_in_reply_to_key: 'nothing-we-ever-sent@elsewhere' },
    });

    expect(r.linked).toBe(false);
    expect(r.state).toBe('UNMATCHED');

    // The row still exists — the customer's words are not discarded.
    const row = await stateOf(orphan);
    expect(row).not.toBeNull();
    expect(row!.reply_link_state).toBe('UNMATCHED');
    expect(row!.in_reply_to_message_id).toBeNull();

    // ...and the provider's claim is kept as evidence for a later retry.
    const ev = await dataService.one<{ provider_in_reply_to_key: string }>(
      `SELECT provider_in_reply_to_key FROM conversation.message WHERE message_id = $1::uuid`,
      [orphan],
    );
    expect(ev!.provider_in_reply_to_key).toBe('nothing-we-ever-sent@elsewhere');

    const queue = await svc.listUnmatchedInbound({ tenant_id: TENANT });
    expect(queue.some((m) => m.message_id === orphan)).toBe(true);
  });

  maybe('a late-arriving parent links on retry', async () => {
    const t = await newThread();
    const orphan = await inbound({ thread_id: t, channel: 'EMAIL', occurred_at: '2026-08-02T10:00:00Z' });
    await svc.detectAndLinkReply({
      tenant_id: TENANT,
      message_id: orphan,
      thread_id: t,
      channel: 'EMAIL',
      occurred_at: '2026-08-02T10:00:00Z',
      signals: { provider_in_reply_to_key: 'late-parent@ours' },
    });
    expect((await stateOf(orphan))!.reply_link_state).toBe('UNMATCHED');

    // The provider backfills the outbound only now.
    const parent = await outbound({
      thread_id: t,
      channel: 'EMAIL',
      occurred_at: '2026-08-02T09:00:00Z',
      provider_message_key: 'late-parent@ours',
    });

    const res = await svc.retryUnmatched({ tenant_id: TENANT });
    expect(res.linked).toBeGreaterThanOrEqual(1);
    const row = await stateOf(orphan);
    expect(row!.reply_link_state).toBe('LINKED');
    expect(row!.in_reply_to_message_id).toBe(parent);
  });
});

describe('schema invariants hold regardless of the writer', () => {
  maybe('an OUTBOUND message can never enter the triage queue', async () => {
    const t = await newThread();
    const out = await outbound({ thread_id: t, channel: 'SMS', occurred_at: '2026-08-01T09:00:00Z' });
    // Try to force it into UNMATCHED behind the service's back.
    await dataService.query(
      `UPDATE conversation.message SET reply_link_state = 'UNMATCHED' WHERE message_id = $1::uuid`,
      [out],
    );
    const row = await stateOf(out);
    expect(row!.reply_link_state).toBe('NOT_APPLICABLE');
  });

  maybe('LINKED with no parent is unrepresentable', async () => {
    const t = await newThread();
    const inb = await inbound({ thread_id: t, channel: 'SMS', occurred_at: '2026-08-01T09:00:00Z' });
    await dataService.query(
      `UPDATE conversation.message SET reply_link_state = 'LINKED' WHERE message_id = $1::uuid`,
      [inb],
    );
    // The trigger re-derives from the (absent) parent rather than trusting the caller.
    const row = await stateOf(inb);
    expect(row!.reply_link_state).toBe('UNMATCHED');
    expect(row!.reply_link_method).toBeNull();
  });
});
