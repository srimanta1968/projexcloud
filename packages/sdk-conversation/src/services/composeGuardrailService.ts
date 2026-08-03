import type { ThreadChannel } from './threadService';

/**
 * Compose guardrails (P16 · EP-381 · PCF-08-3).
 *
 * Answers one question per channel — may we compose on it: allow, review or deny — and
 * says WHY, in order.
 *
 * TWO THINGS THIS DELIBERATELY DOES NOT DO.
 *
 * 1. It does not return a boolean. A bare true/false is unactionable at exactly the moment
 *    someone needs it: an agent staring at a greyed-out SMS button cannot tell whether the
 *    contact opted out, the quiet-hours window is closed, or a frequency cap tripped — and
 *    those have completely different remedies. So every verdict carries an ORDERED reason
 *    list, most severe first, phrased for a human. `reasons[0]` is the headline; the rest
 *    are the runners-up that would ALSO have to be cleared. Ordering is the point: an
 *    unordered set makes the caller re-derive which reason matters most, which is the
 *    judgement this function exists to make.
 *
 * 2. It does not know what consent IS. This SDK is horizontal — it ships to healthcare,
 *    finance and field service, whose consent regimes contradict each other. Encoding
 *    "opted out means deny" here would bake one vertical's rules into every other one's
 *    product. Instead the caller supplies a RESOLVER that reports facts, and this function
 *    only ranks and explains them. It has no consent table, no quiet-hours calendar, no
 *    DNC list and no policy constants: every input arrives from the resolver, so a vertical
 *    changes its rules by changing its resolver, not by forking this package.
 *
 * The split is: the resolver decides WHAT IS TRUE; the guardrail decides HOW SERIOUS IT IS
 * and HOW TO SAY IT.
 */

export type GuardrailVerdict = 'allow' | 'review' | 'deny';

/**
 * Why a channel is not simply allowed. Ordered by severity, and that order IS the contract
 * — `RANK` below is the single place it is defined.
 */
export type GuardrailReasonCode =
  | 'CHANNEL_NOT_AVAILABLE'
  | 'OPTED_OUT'
  | 'SUPPRESSED'
  | 'LEGAL_HOLD'
  | 'NO_SENDER_IDENTITY'
  | 'MISSING_CONSENT'
  | 'QUIET_HOURS'
  | 'FREQUENCY_CAP'
  | 'THREAD_CLOSED'
  | 'AWAITING_HUMAN_REVIEW'
  | 'UNVERIFIED_RECIPIENT'
  | 'RATE_LIMITED';

export interface GuardrailReason {
  code: GuardrailReasonCode;
  /** Human-readable, and meant to be shown as-is next to a disabled compose button. */
  message: string;
  /** The verdict this reason alone would produce. */
  severity: GuardrailVerdict;
  /** Whatever the resolver attached — a cap window, an opt-out timestamp. Opaque here. */
  detail?: Record<string, unknown>;
}

/**
 * Facts the caller reports for one channel. Every field is something only the CONSUMER can
 * know; this package never derives any of them.
 */
export interface ChannelFacts {
  /** The tenant has this channel configured and a way to send on it at all. */
  available?: boolean;
  /** A sending identity exists (mailbox, number, page). */
  has_sender_identity?: boolean;
  /** The subject opted out of this channel. The consumer decides what opting out means. */
  opted_out?: boolean;
  /** On a suppression list (bounce, complaint, manual). */
  suppressed?: boolean;
  /** Consent required by the consumer's regime is absent. */
  consent_missing?: boolean;
  /** Outside the consumer's permitted contact window. */
  quiet_hours?: boolean;
  /** The consumer's own frequency cap is exhausted. */
  frequency_capped?: boolean;
  /** Transport-level rate limit reached. */
  rate_limited?: boolean;
  /** Address/number not verified to the consumer's standard. */
  unverified_recipient?: boolean;
  /** A legal/compliance hold forbids outbound contact. */
  legal_hold?: boolean;
  /** The consumer wants a human to approve sends here. */
  requires_human_review?: boolean;
  /** Free-form context echoed into the matching reason's `detail`. */
  detail?: Partial<Record<GuardrailReasonCode, Record<string, unknown>>>;
}

export interface GuardrailContext {
  tenant_id: string;
  thread_id?: string | null;
  subject_ref?: string | null;
  /** Thread status, when composing onto an existing thread. */
  thread_status?: 'open' | 'awaiting_reply' | 'closed' | null;
  channels: ThreadChannel[];
}

/**
 * The caller-supplied resolver (AC2). Given the context and one channel, report the facts.
 * Async on purpose: real implementations read a consent store or call a policy service.
 */
export type GuardrailResolver = (
  context: GuardrailContext,
  channel: ThreadChannel,
) => Promise<ChannelFacts> | ChannelFacts;

export interface ChannelGuardrail {
  channel: ThreadChannel;
  verdict: GuardrailVerdict;
  /** Most severe first. Empty only when the verdict is 'allow'. */
  reasons: GuardrailReason[];
}

export interface GuardrailDecision {
  tenant_id: string;
  thread_id: string | null;
  /** Per-channel verdicts, in the order the caller asked for them. */
  channels: ChannelGuardrail[];
  /** The best channel available, or null when none is allowed. A convenience, not a policy. */
  recommended_channel: ThreadChannel | null;
  evaluated_at: string;
}

/**
 * Severity ranking. Lower rank = more severe = earlier in the reason list.
 *
 * The ordering encodes one idea: reasons a human cannot resolve by waiting come first. An
 * opt-out or a legal hold is a hard stop no amount of patience fixes; quiet hours and
 * frequency caps clear on their own. Sorting the permanent above the temporary means
 * `reasons[0]` is the thing actually worth telling the user.
 */
const RANK: Record<GuardrailReasonCode, number> = {
  CHANNEL_NOT_AVAILABLE: 0,
  LEGAL_HOLD: 1,
  OPTED_OUT: 2,
  SUPPRESSED: 3,
  MISSING_CONSENT: 4,
  NO_SENDER_IDENTITY: 5,
  UNVERIFIED_RECIPIENT: 6,
  THREAD_CLOSED: 7,
  AWAITING_HUMAN_REVIEW: 8,
  FREQUENCY_CAP: 9,
  RATE_LIMITED: 10,
  QUIET_HOURS: 11,
};

const SEVERITY: Record<GuardrailReasonCode, GuardrailVerdict> = {
  CHANNEL_NOT_AVAILABLE: 'deny',
  LEGAL_HOLD: 'deny',
  OPTED_OUT: 'deny',
  SUPPRESSED: 'deny',
  MISSING_CONSENT: 'deny',
  NO_SENDER_IDENTITY: 'deny',
  UNVERIFIED_RECIPIENT: 'review',
  THREAD_CLOSED: 'review',
  AWAITING_HUMAN_REVIEW: 'review',
  FREQUENCY_CAP: 'review',
  RATE_LIMITED: 'review',
  QUIET_HOURS: 'review',
};

const MESSAGE: Record<GuardrailReasonCode, string> = {
  CHANNEL_NOT_AVAILABLE: 'This channel is not configured for the tenant.',
  LEGAL_HOLD: 'A legal hold prevents outbound contact on this subject.',
  OPTED_OUT: 'The recipient opted out of this channel.',
  SUPPRESSED: 'The recipient is on the suppression list for this channel.',
  MISSING_CONSENT: 'Consent required for this channel has not been recorded.',
  NO_SENDER_IDENTITY: 'No sending identity is configured for this channel.',
  UNVERIFIED_RECIPIENT: 'The recipient address for this channel is unverified.',
  THREAD_CLOSED: 'The thread is closed; reopen it before composing.',
  AWAITING_HUMAN_REVIEW: 'Sends on this channel require human approval.',
  FREQUENCY_CAP: 'The frequency cap for this channel has been reached.',
  RATE_LIMITED: 'This channel is rate limited right now.',
  QUIET_HOURS: 'Outside the permitted contact window for this recipient.',
};

/** 'deny' beats 'review' beats 'allow'. */
function worst(a: GuardrailVerdict, b: GuardrailVerdict): GuardrailVerdict {
  if (a === 'deny' || b === 'deny') return 'deny';
  if (a === 'review' || b === 'review') return 'review';
  return 'allow';
}

const VERDICT_ORDER: Record<GuardrailVerdict, number> = { allow: 0, review: 1, deny: 2 };

/**
 * Turn one channel's facts into an ordered explanation.
 *
 * Note what is absent: no channel is special-cased, no consent rule is applied, and no
 * fact is inferred from another. Each flag maps to exactly one reason, and the ONLY
 * judgement is the ranking.
 */
export function evaluateChannelFacts(
  channel: ThreadChannel,
  facts: ChannelFacts,
  opts: { thread_status?: 'open' | 'awaiting_reply' | 'closed' | null } = {},
): ChannelGuardrail {
  const raised: GuardrailReasonCode[] = [];

  // `available` and `has_sender_identity` are the only flags read as "false is bad";
  // undefined means the resolver did not speak to it, which is not the same as denial.
  if (facts.available === false) raised.push('CHANNEL_NOT_AVAILABLE');
  if (facts.has_sender_identity === false) raised.push('NO_SENDER_IDENTITY');
  if (facts.legal_hold) raised.push('LEGAL_HOLD');
  if (facts.opted_out) raised.push('OPTED_OUT');
  if (facts.suppressed) raised.push('SUPPRESSED');
  if (facts.consent_missing) raised.push('MISSING_CONSENT');
  if (facts.unverified_recipient) raised.push('UNVERIFIED_RECIPIENT');
  if (facts.requires_human_review) raised.push('AWAITING_HUMAN_REVIEW');
  if (facts.frequency_capped) raised.push('FREQUENCY_CAP');
  if (facts.rate_limited) raised.push('RATE_LIMITED');
  if (facts.quiet_hours) raised.push('QUIET_HOURS');

  // Thread state is the one input this package owns, because it is ITS OWN data — not a
  // policy about the recipient. A closed thread is 'review' rather than 'deny': reopening
  // is a decision a human can make, so denying outright would hide a resolvable situation.
  if (opts.thread_status === 'closed') raised.push('THREAD_CLOSED');

  const reasons: GuardrailReason[] = raised
    .sort((a, b) => RANK[a] - RANK[b])
    .map((code) => ({
      code,
      message: MESSAGE[code],
      severity: SEVERITY[code],
      ...(facts.detail?.[code] ? { detail: facts.detail[code] } : {}),
    }));

  const verdict = reasons.reduce<GuardrailVerdict>((acc, r) => worst(acc, r.severity), 'allow');
  return { channel, verdict, reasons };
}

/**
 * Evaluate every requested channel through the caller's resolver.
 *
 * A resolver that THROWS does not take the whole decision down, and — importantly — does
 * not silently become 'allow'. It becomes a deny for that channel with a stated reason,
 * because "we could not determine whether contact is permitted" must never read as
 * permission. Failing open here would send the exact message the guardrail exists to stop.
 */
export async function evaluateComposeGuardrail(
  context: GuardrailContext,
  resolve: GuardrailResolver,
): Promise<GuardrailDecision> {
  if (typeof resolve !== 'function') {
    throw new Error(
      '[sdk-conversation] a guardrail resolver is required — this SDK holds no consent ' +
        'or policy logic of its own and cannot decide without one',
    );
  }
  if (!context.channels?.length) {
    throw new Error('[sdk-conversation] evaluateComposeGuardrail requires at least one channel');
  }

  const channels: ChannelGuardrail[] = [];
  for (const channel of context.channels) {
    // An internal note goes to a colleague, not the customer, so recipient-side policy is
    // simply not applicable — asking the resolver about consent for it would invite a
    // wrong answer. It is allowed here and kept undispatchable by migration 002 instead.
    if (channel === 'INTERNAL_NOTE') {
      channels.push({ channel, verdict: 'allow', reasons: [] });
      continue;
    }

    let facts: ChannelFacts;
    try {
      facts = await resolve(context, channel);
    } catch (err) {
      channels.push({
        channel,
        verdict: 'deny',
        reasons: [
          {
            code: 'CHANNEL_NOT_AVAILABLE',
            message: 'Could not determine whether contact is permitted on this channel.',
            severity: 'deny',
            detail: { resolver_error: (err as Error).message },
          },
        ],
      });
      continue;
    }
    channels.push(evaluateChannelFacts(channel, facts ?? {}, { thread_status: context.thread_status }));
  }

  // Best allowed channel, preferring the caller's own ordering — they listed them in the
  // order they would rather use them, and second-guessing that would be policy.
  const recommended =
    channels.find((c) => c.verdict === 'allow' && c.channel !== 'INTERNAL_NOTE')?.channel ?? null;

  return {
    tenant_id: context.tenant_id,
    thread_id: context.thread_id ?? null,
    channels,
    recommended_channel: recommended,
    evaluated_at: new Date().toISOString(),
  };
}

/** Sort a decision's channels best-first. Presentation only; never changes a verdict. */
export function rankChannels(decision: GuardrailDecision): ChannelGuardrail[] {
  return [...decision.channels].sort(
    (a, b) => VERDICT_ORDER[a.verdict] - VERDICT_ORDER[b.verdict],
  );
}
