import { describe, it, expect } from 'vitest';
import {
  evaluateComposeGuardrail,
  evaluateChannelFacts,
  rankChannels,
  type ChannelFacts,
  type GuardrailContext,
} from '../src/services/composeGuardrailService';

/**
 * The guardrail is pure ranking and explanation — no DB, no policy — so it is unit-tested
 * here. What the api_definition cannot reach is the ORDER of the reason list and the
 * fail-closed behaviour, which is exactly what these assert.
 */

const ctx = (channels: GuardrailContext['channels'], extra: Partial<GuardrailContext> = {}): GuardrailContext => ({
  tenant_id: '22222222-2222-2222-2222-222222222222',
  channels,
  ...extra,
});

describe('ordered reasons, never a bare boolean (AC1)', () => {
  it('returns a verdict plus a reason list, not true/false', async () => {
    const d = await evaluateComposeGuardrail(ctx(['SMS']), () => ({ opted_out: true }));
    const sms = d.channels[0];
    expect(sms.verdict).toBe('deny');
    expect(Array.isArray(sms.reasons)).toBe(true);
    expect(sms.reasons[0].code).toBe('OPTED_OUT');
    expect(sms.reasons[0].message).toMatch(/opted out/i);
    expect(typeof sms.reasons[0].severity).toBe('string');
  });

  it('sorts the permanent above the merely temporary', async () => {
    // Quiet hours clears by waiting; an opt-out never does. The headline must be the
    // opt-out, or the agent is told to come back later about something permanent.
    const d = await evaluateComposeGuardrail(ctx(['EMAIL']), () => ({
      quiet_hours: true,
      frequency_capped: true,
      opted_out: true,
      legal_hold: true,
    }));
    expect(d.channels[0].reasons.map((r) => r.code)).toEqual([
      'LEGAL_HOLD',
      'OPTED_OUT',
      'FREQUENCY_CAP',
      'QUIET_HOURS',
    ]);
  });

  it('keeps every runner-up, not just the headline', async () => {
    const d = await evaluateComposeGuardrail(ctx(['SMS']), () => ({
      opted_out: true,
      quiet_hours: true,
    }));
    // Clearing only the opt-out would still leave quiet hours; hiding it would send the
    // caller round the loop twice.
    expect(d.channels[0].reasons).toHaveLength(2);
  });

  it('an allowed channel has an empty reason list, not a null one', async () => {
    const d = await evaluateComposeGuardrail(ctx(['EMAIL']), () => ({}));
    expect(d.channels[0].verdict).toBe('allow');
    expect(d.channels[0].reasons).toEqual([]);
  });

  it('review and deny are distinct outcomes', async () => {
    const review = evaluateChannelFacts('SMS', { quiet_hours: true });
    const deny = evaluateChannelFacts('SMS', { suppressed: true });
    expect(review.verdict).toBe('review');
    expect(deny.verdict).toBe('deny');
  });

  it('the worst reason sets the verdict even when milder ones outnumber it', async () => {
    const r = evaluateChannelFacts('EMAIL', {
      quiet_hours: true,
      rate_limited: true,
      frequency_capped: true,
      suppressed: true,
    });
    expect(r.verdict).toBe('deny');
  });

  it('passes resolver detail through onto the matching reason', async () => {
    const d = await evaluateComposeGuardrail(ctx(['SMS']), () => ({
      frequency_capped: true,
      detail: { FREQUENCY_CAP: { window: '24h', sent: 5, cap: 5 } },
    }));
    expect(d.channels[0].reasons[0].detail).toEqual({ window: '24h', sent: 5, cap: 5 });
  });
});

describe('inputs come from the caller-supplied resolver (AC2)', () => {
  it('calls the resolver once per requested channel', async () => {
    const seen: string[] = [];
    await evaluateComposeGuardrail(ctx(['EMAIL', 'SMS', 'SOCIAL_DM']), (_c, channel) => {
      seen.push(channel);
      return {};
    });
    expect(seen).toEqual(['EMAIL', 'SMS', 'SOCIAL_DM']);
  });

  it('hands the resolver the full context so it can key on subject and thread', async () => {
    let got: GuardrailContext | null = null;
    await evaluateComposeGuardrail(
      ctx(['EMAIL'], { thread_id: 't-1', subject_ref: 'lead:9' }),
      (c) => {
        got = c;
        return {};
      },
    );
    expect(got!.subject_ref).toBe('lead:9');
    expect(got!.thread_id).toBe('t-1');
  });

  it('refuses to decide with no resolver at all', async () => {
    await expect(
      evaluateComposeGuardrail(ctx(['EMAIL']), undefined as never),
    ).rejects.toThrow(/resolver is required/);
  });

  it('a throwing resolver denies that channel — it never fails open', async () => {
    const d = await evaluateComposeGuardrail(ctx(['EMAIL', 'SMS']), (_c, channel) => {
      if (channel === 'EMAIL') throw new Error('consent service unreachable');
      return {};
    });
    const email = d.channels.find((c) => c.channel === 'EMAIL')!;
    expect(email.verdict).toBe('deny');
    expect(email.reasons[0].detail?.resolver_error).toMatch(/unreachable/);
    // ...and one channel's failure does not poison the others.
    expect(d.channels.find((c) => c.channel === 'SMS')!.verdict).toBe('allow');
  });
});

describe('no consent or policy logic in the SDK (AC3)', () => {
  it('says nothing about a channel the resolver said nothing about', async () => {
    // Silence must not become an invented denial — that would be this package holding an
    // opinion about consent, which is precisely what it must not do.
    const d = await evaluateComposeGuardrail(ctx(['EMAIL']), () => ({}));
    expect(d.channels[0].verdict).toBe('allow');
    expect(d.channels[0].reasons).toEqual([]);
  });

  it('treats undefined and false differently for availability', async () => {
    expect(evaluateChannelFacts('SMS', {}).verdict).toBe('allow');
    expect(evaluateChannelFacts('SMS', { available: false }).verdict).toBe('deny');
  });

  it('applies no channel-specific rule of its own', async () => {
    // Identical facts must produce an identical verdict on every customer-facing channel;
    // a difference would mean a hard-coded assumption about that channel's regime.
    const facts: ChannelFacts = { consent_missing: true };
    const verdicts = (['EMAIL', 'SMS', 'VOICE', 'SOCIAL_DM', 'WEB_CHAT', 'IN_PERSON'] as const).map(
      (c) => evaluateChannelFacts(c, facts).verdict,
    );
    expect(new Set(verdicts).size).toBe(1);
    expect(verdicts[0]).toBe('deny');
  });

  it('an internal note is not subject to recipient policy at all', async () => {
    let asked = false;
    const d = await evaluateComposeGuardrail(ctx(['INTERNAL_NOTE']), () => {
      asked = true;
      return { opted_out: true };
    });
    // The resolver is never consulted: an opt-out is about contacting the CUSTOMER, and a
    // note to a colleague is not contact. Asking would invite a wrong answer.
    expect(asked).toBe(false);
    expect(d.channels[0].verdict).toBe('allow');
  });

  it('never recommends the internal note as a send channel', async () => {
    const d = await evaluateComposeGuardrail(ctx(['INTERNAL_NOTE', 'SMS']), (_c, ch) =>
      ch === 'SMS' ? { opted_out: true } : {},
    );
    expect(d.recommended_channel).toBeNull();
  });

  it('recommends the first allowed channel in the caller\'s own order', async () => {
    const d = await evaluateComposeGuardrail(ctx(['SMS', 'EMAIL']), (_c, ch) =>
      ch === 'SMS' ? { suppressed: true } : {},
    );
    expect(d.recommended_channel).toBe('EMAIL');
  });
});

describe('thread state is the one input this package owns', () => {
  it('a closed thread is review, not deny — reopening is a human decision', async () => {
    const d = await evaluateComposeGuardrail(
      ctx(['EMAIL'], { thread_status: 'closed' }),
      () => ({}),
    );
    expect(d.channels[0].verdict).toBe('review');
    expect(d.channels[0].reasons[0].code).toBe('THREAD_CLOSED');
  });

  it('an open thread raises nothing', async () => {
    const d = await evaluateComposeGuardrail(ctx(['EMAIL'], { thread_status: 'open' }), () => ({}));
    expect(d.channels[0].reasons).toEqual([]);
  });
});

describe('presentation helpers', () => {
  it('rankChannels sorts best-first without altering verdicts', async () => {
    const d = await evaluateComposeGuardrail(ctx(['SMS', 'EMAIL', 'VOICE']), (_c, ch) => {
      if (ch === 'SMS') return { opted_out: true };
      if (ch === 'VOICE') return { quiet_hours: true };
      return {};
    });
    expect(rankChannels(d).map((c) => c.channel)).toEqual(['EMAIL', 'VOICE', 'SMS']);
    expect(d.channels.map((c) => c.channel)).toEqual(['SMS', 'EMAIL', 'VOICE']);
  });

  it('rejects an empty channel list rather than returning an empty decision', async () => {
    await expect(evaluateComposeGuardrail(ctx([]), () => ({}))).rejects.toThrow(/at least one channel/);
  });
});
