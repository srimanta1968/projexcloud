import { getQuietHours, isInQuietHours } from './quietHours';
import { reserveSend, releaseSend } from './frequencyCap';
import { sendWithFailover, type SendArgs } from './providerAdapters';
import type { NotificationChannel } from '../models/notification.model';

/**
 * @projexlight/sdk-notification — unified send transport + sdk-sequence bridge (P14·E4, TK-3631).
 *
 * unifiedDispatch is the single transport that routes a send by channel (email → SES/SMTP
 * with failover, SMS → Twilio) through the provider adapters, honoring per-persona quiet
 * hours. makeSequenceStepSender() adapts an sdk-sequence ExecutableStep to this transport
 * so the step executor delivers real email/SMS via sdk-notification — wired in the gateway
 * with setSequenceStepSender(). A pluggable destination resolver turns a persona into a
 * concrete address/body (default no-op keeps the executor emit-only until wired).
 */

export interface UnifiedDispatchInput {
  tenant_id: string;
  channel: NotificationChannel;
  destination: string;
  body: string;
  subject?: string;
  /** When set with respect_quiet_hours, the persona's quiet hours defer the send. */
  subject_persona_id?: string;
  respect_quiet_hours?: boolean;
  metadata?: Record<string, unknown>;

  /*
   * P16 EP-383 — frequency caps and the no-answer dedup window. ALL OPTIONAL, and every
   * one defaults off: a caller that omits them takes exactly the path it took before this
   * feature existed, which is what keeps the change additive for existing endpoints.
   */
  /** What the send is FOR. Caps are per purpose, so an OTP is not throttled by marketing. */
  purpose?: string;
  /** Enforce the tenant's per-channel/per-purpose daily cap. Off unless asked. */
  respect_frequency_cap?: boolean;
  /** Supply to enable dedup, or set auto_dedup to derive it from the message itself. */
  dedup_key?: string;
  auto_dedup?: boolean;
}

export interface UnifiedDispatchResult {
  status: 'sent' | 'deferred' | 'failed' | 'suppressed';
  provider?: string;
  provider_message_id?: string | null;
  delivered_status?: string;
  reason?: string;
  /** Set when a cap or the dedup window stopped the send, so a caller can tell them apart. */
  blocked_by?: 'dedup' | 'cap';
}

/**
 * Pluggable pre-send guard. The app wires this to sdk-deliverability (isSuppressed +
 * reputation isChannelPaused) so a suppressed recipient or a paused channel is skipped
 * BEFORE the provider is called. Default allows everything (no deliverability wired).
 */
export type PreSendGuard = (args: { tenant_id: string; channel: NotificationChannel; destination: string }) => Promise<{ blocked: boolean; reason?: string }>;
const defaultGuard: PreSendGuard = async () => ({ blocked: false });
let _guard: PreSendGuard = defaultGuard;
export function setPreSendGuard(guard: PreSendGuard): void { _guard = guard; }
export function _resetPreSendGuard(): void { _guard = defaultGuard; }

/**
 * Route one message through the channel's provider chain (with failover), deferring if
 * the recipient persona is in quiet hours. Never throws — a provider failure returns
 * status:'failed' with the reason.
 */
export async function unifiedDispatch(input: UnifiedDispatchInput): Promise<UnifiedDispatchResult> {
  // Pre-send guard first: a suppressed recipient / paused channel never reaches a provider.
  const guard: { blocked: boolean; reason?: string } = await _guard({ tenant_id: input.tenant_id, channel: input.channel, destination: input.destination }).catch(() => ({ blocked: false }));
  if (guard.blocked) return { status: 'suppressed', reason: guard.reason ?? 'blocked by pre-send guard' };

  if (input.respect_quiet_hours && input.subject_persona_id) {
    const record = await getQuietHours(input.subject_persona_id).catch(() => null);
    const q = isInQuietHours(record);
    if (q.quiet) return { status: 'deferred', reason: q.reason };
  }

  /*
   * Cap + dedup (P16 EP-383). Reached ONLY when the caller opted in, so existing endpoints
   * are untouched. Placed after quiet hours deliberately: a deferred send has not happened,
   * so reserving a cap unit for it would charge the tenant for a message still to come.
   */
  const wantsGuard = input.respect_frequency_cap === true
    || input.auto_dedup === true
    || input.dedup_key !== undefined;
  let ledgerId: string | null = null;

  if (wantsGuard) {
    const decision = await reserveSend({
      tenant_id: input.tenant_id,
      channel: input.channel,
      purpose: input.purpose,
      destination: input.destination,
      body: input.body,
      dedup_key: input.dedup_key,
      auto_dedup: input.auto_dedup,
    });
    if (!decision.allowed) {
      return { status: 'suppressed', reason: decision.reason, blocked_by: decision.blocked_by };
    }
    ledgerId = decision.ledger_id;
  }

  try {
    const args: SendArgs = {
      channel: input.channel, destination: input.destination,
      subject: input.subject, body: input.body, metadata: input.metadata,
    };
    const r = await sendWithFailover(input.channel, args);
    const failed = r.delivered_status === 'failed' || r.delivered_status === 'bounced';
    // A failed send must not burn the cap or arm the dedup window — otherwise a provider
    // outage exhausts the allowance on messages nobody received, and the window then
    // blocks the very retry meant to fix it.
    if (failed) await releaseSend(ledgerId).catch(() => undefined);
    return {
      status: failed ? 'failed' : 'sent',
      provider: r.provider,
      provider_message_id: r.provider_message_id,
      delivered_status: r.delivered_status,
    };
  } catch (err) {
    await releaseSend(ledgerId).catch(() => undefined);
    return { status: 'failed', reason: (err as Error).message };
  }
}

/* ------------------------------------------------------ sdk-sequence bridge */

/** Structural subset of sdk-sequence's ExecutableStep — avoids a hard dep on sdk-sequence. */
export interface SequenceStepLike {
  tenant_id: string;
  channel: string | null;
  subject_persona_id: string;
  template_id: string | null;
}
export interface StepSendOutcome {
  delivered: boolean;
  provider_message_id?: string | null;
  error?: string;
}
export interface ResolvedDestination {
  destination: string;
  body: string;
  subject?: string;
  channel?: NotificationChannel;
}
/** Resolve a sequence step's persona/template into a concrete address + rendered body. */
export type SequenceDestinationResolver = (step: SequenceStepLike) => Promise<ResolvedDestination | null>;

const defaultResolver: SequenceDestinationResolver = async () => null;
let _destResolver: SequenceDestinationResolver = defaultResolver;

/** Install the destination resolver (app resolves persona -> address + template body). */
export function setSequenceDestinationResolver(resolver: SequenceDestinationResolver): void {
  _destResolver = resolver;
}
export function _resetSequenceDestinationResolver(): void {
  _destResolver = defaultResolver;
}

/**
 * Build a SequenceStepSender (for sdk-sequence's setSequenceStepSender) that delivers a
 * step's email/SMS through unifiedDispatch. Non-send channels (wait/task/call) and steps
 * with no resolvable destination emit-only (delivered:true, no provider) so the executor
 * stays exercisable until a real resolver + providers are wired.
 */
export function makeSequenceStepSender(): (step: SequenceStepLike) => Promise<StepSendOutcome> {
  return async (step: SequenceStepLike): Promise<StepSendOutcome> => {
    const chan = (step.channel ?? 'email') as NotificationChannel;
    if (chan !== 'email' && chan !== 'sms') return { delivered: true, provider_message_id: null };
    const resolved = await _destResolver(step);
    if (!resolved) return { delivered: true, provider_message_id: null };
    const r = await unifiedDispatch({
      tenant_id: step.tenant_id,
      channel: resolved.channel ?? chan,
      destination: resolved.destination,
      body: resolved.body,
      subject: resolved.subject,
      subject_persona_id: step.subject_persona_id,
      respect_quiet_hours: true,
    });
    return {
      delivered: r.status === 'sent',
      provider_message_id: r.provider_message_id ?? null,
      error: r.status === 'failed' ? r.reason : undefined,
    };
  };
}
