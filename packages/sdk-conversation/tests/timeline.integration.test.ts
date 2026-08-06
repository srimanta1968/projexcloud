import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'crypto';
import { initPool, dataService, closeAllPools } from '@projexlight/db-runtime';

/**
 * The chronological timeline, against a REAL Postgres.
 *
 * WHY THIS FILE EXISTS. This is the task's headline acceptance — "a single chronological
 * timeline renders correctly when messages arrive out of order from different providers"
 * — and until now nothing exercised it. `listThreadMessages` is the function that
 * produces the timeline, and no test called it: routes.test.ts mocks it to THROW if
 * reached, and replyDetection.integration.test.ts imports only replyDetection.
 * threadService.test.ts says in its own header that ordering is "proven against real
 * Postgres, not re-asserted here" — a reasonable division of labour, except the proof
 * was never written on the other side of it.
 *
 * WHY IT IS A DB TEST rather than an api_definition case. The property is a SQL ordering
 * invariant of migration 002 (ORDER BY occurred_at, received_at, message_id), and the
 * thing that makes it interesting is INSERT order differing from occurred_at order. An
 * HTTP dataset can assert a response body; it cannot easily seed three providers racing.
 *
 * OUT OF ORDER IS THE NORMAL CASE, not an edge case. Providers deliver webhooks over
 * independent connections with independent retry schedules, so a Twilio SMS sent at 09:15
 * routinely lands after a SendGrid email sent at 09:30. A timeline that ordered by
 * arrival would show the rep answering a question the customer had not asked yet.
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

// Explicit opt-out, matching replyDetection.integration.test.ts: unset means an
// unreachable database FAILS rather than quietly passing.
const SKIP_DB_TESTS = process.env.SKIP_DB_TESTS === '1';
let dbUp = false;
const TENANT = randomUUID();

let svc: typeof import('../src/services/threadService');

beforeAll(async () => {
  try {
    initPool({ primary: PG });
    await dataService.query('SELECT 1');
    await dataService.query(`SELECT 1 FROM conversation.message LIMIT 1`);
    dbUp = true;
  } catch (err) {
    dbUp = false;
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
  svc = await import('../src/services/threadService');
});

afterAll(async () => {
  if (!dbUp) return;
  await dataService.query(`DELETE FROM conversation.message WHERE tenant_id = $1::uuid`, [TENANT]);
  await dataService.query(`DELETE FROM conversation.thread WHERE tenant_id = $1::uuid`, [TENANT]);
  await closeAllPools();
});

async function newThread(purpose = 'timeline fixture'): Promise<string> {
  const r = await dataService.one<{ thread_id: string }>(
    `INSERT INTO conversation.thread (tenant_id, subject_ref, purpose)
     VALUES ($1::uuid, $2, $3) RETURNING thread_id::text`,
    [TENANT, `lead:${randomUUID()}`, purpose],
  );
  return r!.thread_id;
}

const maybe = (name: string, fn: () => Promise<void>) =>
  it(name, async (ctx) => {
    if (!dbUp) { ctx.skip(); return; }
    await fn();
  });

describe('a single chronological timeline across providers (AC1)', () => {
  maybe('orders by when it HAPPENED, not by when the provider told us', async () => {
    const thread_id = await newThread();

    // Written in deliberately scrambled order, each on a different channel, exactly as
    // four independent provider webhooks would land. The insert sequence below is the
    // REVERSE of nothing in particular — it is simply not chronological, which is the
    // point.
    await svc.recordMessage({
      tenant_id: TENANT, thread_id, channel: 'EMAIL', direction: 'OUTBOUND',
      body_ref: 'vault:c', actor: 'persona:rep', occurred_at: '2026-08-01T11:00:00Z',
    });
    await svc.recordMessage({
      tenant_id: TENANT, thread_id, channel: 'SMS', direction: 'INBOUND',
      body_ref: 'vault:a', actor: 'contact:them', occurred_at: '2026-08-01T09:00:00Z',
    });
    await svc.recordMessage({
      tenant_id: TENANT, thread_id, channel: 'WEB_CHAT', direction: 'INBOUND',
      body_ref: 'vault:d', actor: 'contact:them', occurred_at: '2026-08-01T12:00:00Z',
    });
    await svc.recordMessage({
      tenant_id: TENANT, thread_id, channel: 'VOICE', direction: 'OUTBOUND',
      body_ref: 'vault:b', actor: 'persona:rep', occurred_at: '2026-08-01T10:00:00Z',
    });

    const timeline = await svc.listThreadMessages({ thread_id });

    expect(timeline.map((m) => m.body_ref)).toEqual([
      'vault:a', 'vault:b', 'vault:c', 'vault:d',
    ]);
    // The channels interleave — this is one conversation, not four per-channel logs
    // stitched together, which is the whole claim of an omnichannel thread.
    expect(timeline.map((m) => m.channel)).toEqual([
      'SMS', 'VOICE', 'EMAIL', 'WEB_CHAT',
    ]);
  });

  maybe('breaks an exact tie deterministically instead of reshuffling', async () => {
    const thread_id = await newThread();
    // Two providers CAN report the same instant — a call that ends as an SMS auto-reply
    // fires, say — and second-resolution timestamps make it commonplace. Without the
    // message_id tie-break the two rows come back in whatever order the planner felt
    // like, so the timeline would reorder itself between two reads of the same thread
    // and an operator would not trust what they were looking at.
    const same = '2026-08-01T09:00:00Z';
    await svc.recordMessage({
      tenant_id: TENANT, thread_id, channel: 'SMS', direction: 'INBOUND',
      body_ref: 'vault:tie-1', actor: 'contact:them', occurred_at: same,
    });
    await svc.recordMessage({
      tenant_id: TENANT, thread_id, channel: 'EMAIL', direction: 'INBOUND',
      body_ref: 'vault:tie-2', actor: 'contact:them', occurred_at: same,
    });

    const first = await svc.listThreadMessages({ thread_id });
    const second = await svc.listThreadMessages({ thread_id });
    expect(first).toHaveLength(2);
    expect(second.map((m) => m.message_id)).toEqual(first.map((m) => m.message_id));
  });

  maybe('places an internal note in the same timeline, still marked as internal', async () => {
    const thread_id = await newThread();
    await svc.recordMessage({
      tenant_id: TENANT, thread_id, channel: 'EMAIL', direction: 'OUTBOUND',
      body_ref: 'vault:visible-1', actor: 'persona:rep', occurred_at: '2026-08-01T09:00:00Z',
    });
    await svc.addInternalNote({
      tenant_id: TENANT, thread_id, body_ref: 'vault:note', actor: 'persona:rep',
      occurred_at: '2026-08-01T09:30:00Z',
    });
    await svc.recordMessage({
      tenant_id: TENANT, thread_id, channel: 'EMAIL', direction: 'INBOUND',
      body_ref: 'vault:visible-2', actor: 'contact:them', occurred_at: '2026-08-01T10:00:00Z',
    });

    const timeline = await svc.listThreadMessages({ thread_id });
    expect(timeline.map((m) => m.body_ref)).toEqual([
      'vault:visible-1', 'vault:note', 'vault:visible-2',
    ]);
    // A note sits in the thread chronologically — it is context for the rep at the point
    // it was written — but it must stay separable, because rendering it as a customer
    // message is how private commentary reaches the customer.
    const note = timeline.find((m) => m.body_ref === 'vault:note');
    expect(note!.channel).toBe('INTERNAL_NOTE');
    expect(note!.direction).toBe('INTERNAL');

    // Separable in the way that actually matters: the transcript a customer could be
    // shown drops the note and keeps its own order. Asserting only the channel field
    // would prove the note is LABELLED internal, not that anything acts on the label.
    const visible = await svc.listThreadMessages({ thread_id, exclude_internal: true });
    expect(visible.map((m) => m.body_ref)).toEqual(['vault:visible-1', 'vault:visible-2']);
  });
});
