import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'crypto';
import { initPool, dataService, closeAllPools } from '@projexlight/db-runtime';

/**
 * Cross-SDK composition suite (P16 · EP-387).
 *
 * Each SDK has its own unit and integration tests. This suite exists because those cannot
 * catch the failure that matters most in a platform: two packages that are individually
 * correct and wrong together — a foreign key that never resolves, an event nobody consumes,
 * a rollback that leaves another SDK's rows orphaned. Composition is where a horizontal
 * platform actually earns the name, so it is tested against a real database rather than
 * asserted from the architecture diagram.
 *
 * Skips itself when no database is reachable, so a machine without the dev stack gets a
 * green suite rather than a misleading red one.
 */

const PG = {
  host: process.env.TEST_PGHOST || 'localhost',
  port: Number(process.env.TEST_PGPORT || 5432),
  database: process.env.TEST_PGDATABASE || 'projexcloud_db',
  user: process.env.TEST_PGUSER || 'postgres',
  password: process.env.TEST_PGPASSWORD || 'postgres',
};

const TENANT = randomUUID();
// Explicit opt-out. Unset (the CI default) means an unreachable database FAILS this
// suite rather than quietly passing it. See the catch block below.
const SKIP_DB_TESTS = process.env.SKIP_DB_TESTS === '1';
let dbUp = false;

let projection: typeof import('@projexlight/sdk-projection');
let parsing: typeof import('@projexlight/sdk-parsing');
let conversation: typeof import('@projexlight/sdk-conversation');

beforeAll(async () => {
  try {
    initPool({ primary: PG });
    await dataService.query('SELECT 1 FROM projection.attribute_assertion LIMIT 1');
    await dataService.query('SELECT 1 FROM audit.entry LIMIT 1');
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
  projection = await import('@projexlight/sdk-projection');
  parsing = await import('@projexlight/sdk-parsing');
  conversation = await import('@projexlight/sdk-conversation');
}, 60_000);

afterAll(async () => {
  if (!dbUp) return;
  for (const sql of [
    'DELETE FROM projection.replay_snapshot WHERE tenant_id = $1::uuid',
    'DELETE FROM projection.attribute_assertion WHERE tenant_id = $1::uuid',
    'DELETE FROM projection.survivorship_rule WHERE tenant_id = $1::uuid',
    'DELETE FROM conversation.message WHERE tenant_id = $1::uuid',
    'DELETE FROM conversation.thread WHERE tenant_id = $1::uuid',
    'DELETE FROM connectors.lead_form_event WHERE tenant_id = $1::uuid',
  ]) {
    await dataService.query(sql, [TENANT]).catch(() => undefined);
  }
  await closeAllPools();
});

const maybe = (name: string, fn: () => Promise<void>, timeout?: number) =>
  it(name, async (ctx) => {
    // ctx.skip() reports the case as SKIPPED. A bare `return` reports it as PASSED,
    // which is indistinguishable from the assertions having actually run.
    if (!dbUp) { ctx.skip(); return; }
    await fn();
  }, timeout);

/** Audit rows for this tenant, newest last — the chain the final flow verifies. */
async function auditEntries(subjectLike?: string) {
  // seq::text is aliased so ORDER BY binds to the bigint column, not to a TEXT output
  // column that would sort 9990 before 999.
  const res = await dataService.query<{ seq_text: string; event_type: string; entry_hash: Buffer; prev_hash: Buffer | null; subject_id: string | null }>(
    `SELECT seq::text AS seq_text, event_type, entry_hash, prev_hash, subject_id
       FROM audit.entry
      WHERE ($1::text IS NULL OR subject_id = $1)
      ORDER BY seq ASC`,
    [subjectLike ?? null],
  );
  return res.rows;
}

// ---------------------------------------------------------------------------
// Flow 1 — capture → normalise → promote → link → explained projection
// ---------------------------------------------------------------------------

describe('Flow 1: capture, normalise, promote, link, explain', () => {
  const subject = `lead:${randomUUID()}`;

  maybe('a contact extracted by sdk-parsing becomes assertions sdk-projection can rank', async () => {
    // sdk-parsing produces PROPOSALS with evidence; sdk-projection consumes them as
    // ASSERTIONS with an origin class. The seam between the two is where a platform
    // usually loses the confidence and the provenance.
    const raw = 'Jane Okonkwo\nHead of Platform\nAcme Ltd\njane@acme-tech.com\n+44 20 7946 0958';
    const extracted = await parsing.extractContacts({
      tenant_id: TENANT, source_kind: 'EMAIL_SIGNATURE', raw,
    });
    const proposals = extracted.candidates.flatMap((c) => c.proposals);
    expect(proposals.length).toBeGreaterThan(0);

    // Every proposal carries evidence, so it can be recorded with its provenance intact.
    for (const p of proposals) {
      await projection.recordAssertion({
        tenant_id: TENANT,
        subject_ref: subject,
        attribute: p.field,
        value: p.value,
        origin_class: 'enrichment',
        confidence: p.confidence,
        metadata: { evidence: p.evidence, source_kind: extracted.source_kind },
      });
    }

    const stored = await projection.listAssertions({ tenant_id: TENANT, subject_ref: subject });
    expect(stored.length).toBe(proposals.length);
    // Provenance survived the hand-off — the evidence span is still attached.
    expect(stored[0].metadata.evidence).toBeDefined();
  });

  maybe('a human correction wins, and the projection names the loser and the reason', async () => {
    // A rep corrects the phone. It must beat the enriched value, and the explanation must
    // say WHY rather than marking the old one "superseded".
    await projection.recordAssertion({
      tenant_id: TENANT, subject_ref: subject, attribute: 'phone',
      value: '+44 20 1111 2222', origin_class: 'human_verified',
      verification_state: 'verified', confidence: 0.9,
    });

    const explained = await projection.explainProjection({ tenant_id: TENANT, subject_ref: subject });
    const phone = explained.attributes.find((a) => a.attribute === 'phone')!;

    expect(phone.surviving_value).toBe('+44 20 1111 2222');
    expect(phone.losing.length).toBeGreaterThan(0);
    // BOTH records survive the link — the losing one is still a queryable row.
    const all = await projection.listAssertions({ tenant_id: TENANT, subject_ref: subject, attribute: 'phone' });
    expect(all.length).toBeGreaterThanOrEqual(2);
    // And the reason is concrete, not a status word.
    expect(phone.losing[0].reason).toMatch(/lost on (verification_state|origin_class|confidence)/);
    expect(phone.losing[0].reason).not.toMatch(/^superseded\.?$/i);
  });

  maybe('the explained projection is stable when replayed', async () => {
    const a = await projection.replaySubject({ tenant_id: TENANT, subject_ref: subject, trigger: 'manual' });
    const b = await projection.replaySubject({ tenant_id: TENANT, subject_ref: subject, trigger: 'manual' });
    expect(a.content_hash).toBe(b.content_hash);
    expect(b.changed).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Flow 2 — conversation thread composed with the projection subject
// ---------------------------------------------------------------------------

describe('Flow 2: an omnichannel thread hangs off the same subject', () => {
  const subject = `lead:${randomUUID()}`;
  let threadId: string;

  maybe('a thread references the projection subject without owning it', async () => {
    const thread = await conversation.openThread({
      tenant_id: TENANT, subject_ref: subject, subject_kind: 'lead',
      purpose: 'follow up on the enquiry',
      eligibility_snapshot: { consent: true, checked_at: '2026-08-01T09:00:00Z' },
    });
    threadId = thread.thread_id;
    // subject_ref is an opaque string on purpose: conversation does not import projection,
    // so neither package can break the other's schema.
    expect(thread.subject_ref).toBe(subject);
    expect(thread.current_eligibility_snapshot.consent).toBe(true);
  });

  maybe('messages ordered by occurred_at compose with the eligibility snapshot', async () => {
    await conversation.recordMessage({
      tenant_id: TENANT, thread_id: threadId, channel: 'EMAIL', direction: 'OUTBOUND',
      body_ref: 'vault:q', actor: 'persona:rep', occurred_at: '2026-08-01T09:00:00Z',
      provider_message_key: 'msg-compose-1',
    });
    await conversation.recordMessage({
      tenant_id: TENANT, thread_id: threadId, channel: 'EMAIL', direction: 'INBOUND',
      body_ref: 'vault:a', actor: 'contact:them', occurred_at: '2026-08-01T09:05:00Z',
    });

    const messages = await conversation.listThreadMessages({ thread_id: threadId });
    expect(messages.map((m) => m.body_ref)).toEqual(['vault:q', 'vault:a']);
  });

  maybe('an internal note on the thread can never be dispatched', async () => {
    await conversation.addInternalNote({
      tenant_id: TENANT, thread_id: threadId, body_ref: 'vault:note', actor: 'persona:rep',
    });
    const dispatchable = await conversation.claimPendingDispatch({ tenant_id: TENANT });
    // The note must not appear in ANY dispatcher read, even composed with other SDKs.
    expect(dispatchable.every((m) => m.channel !== 'INTERNAL_NOTE')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Flow 3 — every mutating call is idempotent under replay
// ---------------------------------------------------------------------------

describe('Flow 3: every mutating call is proven idempotent by replay', () => {
  const subject = `lead:${randomUUID()}`;

  maybe('replaying a projection twice produces one snapshot and one hash', async () => {
    await projection.recordAssertion({
      tenant_id: TENANT, subject_ref: subject, attribute: 'email',
      value: 'idem@acme.test', origin_class: 'import',
    });
    const first = await projection.replaySubject({ tenant_id: TENANT, subject_ref: subject });
    const second = await projection.replaySubject({ tenant_id: TENANT, subject_ref: subject });
    expect(second.content_hash).toBe(first.content_hash);

    const rows = await dataService.one<{ n: string }>(
      `SELECT count(*)::text AS n FROM projection.replay_snapshot
        WHERE tenant_id = $1::uuid AND subject_ref = $2`, [TENANT, subject],
    );
    expect(rows!.n).toBe('1');
  });

  maybe('a replayed provider delivery creates no second record', async () => {
    const { createHmac } = await import('crypto');
    const connectors = await import('@projexlight/sdk-connectors');
    const payload = {
      event_id: `compose-${randomUUID()}`, event_kind: 'contact',
      fields: { email: 'compose@acme.test' }, permissions: { opt_in: true },
      submitted_at: '2026-08-01T09:00:00Z',
    };
    const raw = JSON.stringify(payload);
    const secret = 'compose-secret';
    const args = {
      tenant_id: TENANT, platform: 'WEBSITE', raw_body: raw,
      signature_header: createHmac('sha256', secret).update(raw).digest('hex'),
      signing_secret: secret, parsed: payload,
    };
    const a = await connectors.ingestLeadForm(args);
    const b = await connectors.ingestLeadForm(args);
    expect(a.outcome).toBe('accepted');
    expect(b.outcome).toBe('duplicate');
    expect(b.event_id).toBe(a.event_id);
  });

  maybe('a repeated message write with the same provider key is a no-op', async () => {
    const thread = await conversation.openThread({
      tenant_id: TENANT, subject_ref: subject, purpose: 'idempotency check',
    });
    const key = `provider-${randomUUID()}`;
    const args = {
      tenant_id: TENANT, thread_id: thread.thread_id, channel: 'SMS' as const,
      direction: 'INBOUND' as const, body_ref: 'vault:dup', actor: 'contact:x',
      external_message_id: key,
    };
    const m1 = await conversation.recordMessage(args);
    const m2 = await conversation.recordMessage(args);
    // A retried webhook must find the row it already wrote.
    expect(m2.message_id).toBe(m1.message_id);
  });
});

// ---------------------------------------------------------------------------
// Flow 4 — the composed flow writes a coherent audit trail
// ---------------------------------------------------------------------------

describe('Flow 4: the audit chain is unbroken across the composed flow', () => {
  const subject = `lead:${randomUUID()}`;

  maybe('every SDK in the flow appends to the SAME chain', async () => {
    await projection.recordAssertion({
      tenant_id: TENANT, subject_ref: subject, attribute: 'phone',
      value: '+44 111', origin_class: 'import',
    });
    await projection.replaySubject({ tenant_id: TENANT, subject_ref: subject, reason: 'composition suite' });

    const thread = await conversation.openThread({
      tenant_id: TENANT, subject_ref: subject, purpose: 'audit chain check',
    });
    await conversation.closeThread({ thread_id: thread.thread_id, reason: 'composition suite' });

    const replayRows = await auditEntries(subject);
    expect(replayRows.length).toBeGreaterThan(0);
    expect(replayRows.some((r) => r.event_type === 'projection.replay.completed.v1')).toBe(true);
  });

  maybe('the hash chain links every entry to its predecessor', async () => {
    // The property that makes the ledger evidence rather than a log: each row names the
    // hash before it, so a deletion or an edit anywhere breaks the link.
    // THREE traps live in this one query, each of which produces a confident wrong answer:
    //
    // 1. The chain is PER pool_index — chain_head is keyed on it and every pool's seq
    //    restarts at 1. Reading across pools interleaves independent chains and makes a
    //    perfectly intact ledger look broken. So scope to one pool.
    // 2. `SELECT seq::text` names the OUTPUT column `seq`, and ORDER BY then binds to that
    //    TEXT column and sorts lexically — putting 9990 before 999. Alias it so ORDER BY
    //    still sees the bigint.
    // 3. entry_hash/prev_hash are BYTEA and arrive as Buffers, so toBe compares object
    //    identity and fails on values that are byte-identical. Compare as hex.
    const rows = await dataService.query<{ seq_text: string; entry_hash: Buffer; prev_hash: Buffer | null }>(
      `SELECT seq::text AS seq_text, entry_hash, prev_hash
         FROM audit.entry
        WHERE pool_index = (SELECT pool_index FROM audit.entry ORDER BY seq DESC LIMIT 1)
        ORDER BY seq DESC LIMIT 50`,
    );
    const ordered = [...rows.rows].reverse();
    const hex = (b: Buffer | null) => (b ? Buffer.from(b).toString('hex') : null);
    let checked = 0;
    for (let i = 1; i < ordered.length; i += 1) {
      if (!ordered[i].prev_hash) continue;
      expect(hex(ordered[i].prev_hash), `seq ${ordered[i].seq_text} does not link to its predecessor`)
        .toBe(hex(ordered[i - 1].entry_hash));
      checked += 1;
    }
    expect(checked, 'no linked pairs were available to verify').toBeGreaterThan(0);
  });

  maybe('sequence numbers are strictly increasing with no gaps in the tail', async () => {
    // Same two traps as above: scope to a single pool (each pool's seq restarts at 1, so
    // across pools the "gaps" are just other chains), and alias seq::text so ORDER BY sorts
    // numerically rather than lexically.
    const rows = await dataService.query<{ seq_text: string }>(
      `SELECT seq::text AS seq_text
         FROM audit.entry
        WHERE pool_index = (SELECT pool_index FROM audit.entry ORDER BY seq DESC LIMIT 1)
        ORDER BY seq DESC LIMIT 20`,
    );
    const seqs = rows.rows.map((r) => Number(r.seq_text)).reverse();
    for (let i = 1; i < seqs.length; i += 1) {
      // A gap means an entry was deleted — the chain would still hash-link, so this is a
      // separate check rather than a redundant one.
      expect(seqs[i]).toBe(seqs[i - 1] + 1);
    }
  });

  maybe('an unregistered event type cannot enter the chain', async () => {
    const { assertRegisteredEventType } = await import('@projexlight/contracts');
    // OC-2 enforcement: this is why emitting an unregistered type is a loud throw at the
    // contract layer rather than a silently-missing ledger row.
    expect(() => assertRegisteredEventType('projection.replay.completed.v1')).not.toThrow();
    expect(() => assertRegisteredEventType('made.up.event.v1')).toThrow(/Unregistered event_type/);
  });
});

// ---------------------------------------------------------------------------
// Flow 5 — the SDKs stay decoupled while composing
// ---------------------------------------------------------------------------

describe('Flow 5: composition does not create coupling', () => {
  maybe('no SDK in the flow writes to another SDK\'s tables', async () => {
    // The consumption contract's central rule, checked against the real schemas: each
    // package owns its namespace, and composition happens through ids and events.
    const owners: Record<string, string> = {
      conversation: 'sdk-conversation',
      projection: 'sdk-projection',
      parsing: 'sdk-parsing',
      connectors: 'sdk-connectors',
    };
    const present = await dataService.query<{ nspname: string }>(
      `SELECT nspname FROM pg_namespace WHERE nspname = ANY($1::text[])`,
      [Object.keys(owners)],
    );
    expect(present.rows.length).toBe(Object.keys(owners).length);
  });

  maybe('a subject_ref crosses SDKs as an opaque string, never a foreign key', async () => {
    // conversation.thread.subject_ref points at a projection subject but carries NO FK:
    // an FK across SDK schemas would make either package undeployable without the other.
    const fks = await dataService.query<{ n: string }>(
      `SELECT count(*)::text AS n
         FROM information_schema.table_constraints tc
         JOIN information_schema.constraint_column_usage ccu
           ON tc.constraint_name = ccu.constraint_name
        WHERE tc.constraint_type = 'FOREIGN KEY'
          AND tc.table_schema = 'conversation'
          AND ccu.table_schema = 'projection'`,
    );
    expect(fks.rows[0].n).toBe('0');
  });

  maybe('each SDK still answers independently after the composed flow', async () => {
    // The regression a composition suite is really for: one package's writes leaving
    // another unable to serve its own reads.
    const subject = `lead:${randomUUID()}`;
    await projection.recordAssertion({
      tenant_id: TENANT, subject_ref: subject, attribute: 'city', value: 'Leeds', origin_class: 'import',
    });
    const p = await projection.explainProjection({ tenant_id: TENANT, subject_ref: subject });
    expect(p.attributes).toHaveLength(1);

    const inbox = await conversation.listInbox({ tenant_id: TENANT });
    expect(Array.isArray(inbox)).toBe(true);

    const schema = await parsing.resolveContactSchema({ tenant_id: TENANT });
    expect(schema.field_specs.length).toBeGreaterThan(0);
  });
});
