import { ParticipantKind, RoomEvent, type RemoteParticipant, type Room } from '@livekit/rtc-node';
import { ControlPlaneError, type BootstrapRequest, type ControlPlane, type Fallback } from '../controlPlane';
import type { CallHandler } from '../livekit/roomJob';
import { holdUntilCallerLeaves } from '../livekit/roomJob';
import type { JobContext } from '../livekit/worker';
import { log } from '../log';
import type { SessionContext, SessionStore } from '../session/sessionStore';

/**
 * One call, end to end (VA·E1 · TK-4457): work out which call this job is, bootstrap it with
 * ONE control-plane request, keep the session in memory (+ Redis mirror) while the
 * conversation runs, and drop it when the call ends.
 *
 *   - Test sessions and outbound calls: the LiveKit dispatch metadata carries call_id.
 *   - Inbound SIP: the dispatch rule's metadata has no call yet; the SIP participant's
 *     attributes carry the dialled number (sip.trunkPhoneNumber), the caller
 *     (sip.phoneNumber) and the SIP call id, and the bootstrap opens the call.
 */

export type Conversation = (room: Room, session: SessionContext, ctx: JobContext) => Promise<void>;
export type FallbackHandler = (room: Room, fallback: Fallback, ctx: JobContext) => Promise<void>;

/** Placeholder until the pipeline plugs in: keep the session until the caller leaves. */
export const holdConversation: Conversation = (room, _s, ctx) => holdUntilCallerLeaves(room, ctx);

/** Without a fallback speaker: log and leave (the room closes, the carrier hangs up). */
export const leaveOnFallback: FallbackHandler = async (_room, fb, ctx) => {
  log.info('inbound number is not answering with an agent', { jobId: ctx.job.id, reason: fb.reason, fallback: fb.fallback });
};

const SIP_WAIT_MS = Number(process.env.VOICE_RUNTIME_SIP_WAIT_MS ?? 10_000);

function dispatchMetadata(ctx: JobContext): Record<string, unknown> {
  try {
    const m = JSON.parse(ctx.job.metadata || '{}');
    return m && typeof m === 'object' ? (m as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function sipCaller(room: Room): RemoteParticipant | undefined {
  return [...room.remoteParticipants.values()].find((p) => p.kind === ParticipantKind.SIP);
}

async function waitForSipCaller(room: Room): Promise<RemoteParticipant | undefined> {
  const now = sipCaller(room);
  if (now) return now;
  return new Promise((resolve) => {
    const t = setTimeout(() => { room.off(RoomEvent.ParticipantConnected, on); resolve(undefined); }, SIP_WAIT_MS);
    const on = (p: RemoteParticipant): void => {
      if (p.kind !== ParticipantKind.SIP) return;
      clearTimeout(t);
      room.off(RoomEvent.ParticipantConnected, on);
      resolve(p);
    };
    room.on(RoomEvent.ParticipantConnected, on);
  });
}

/** What to ask the bootstrap for, or null when the job cannot be tied to a call. */
async function bootstrapRequest(room: Room, ctx: JobContext): Promise<BootstrapRequest | null> {
  const meta = dispatchMetadata(ctx);
  if (typeof meta.call_id === 'string') return { call_id: meta.call_id };
  const sip = await waitForSipCaller(room);
  const to = sip?.attributes['sip.trunkPhoneNumber'];
  if (!sip || !to) return null;
  return {
    inbound: {
      to,
      from: sip.attributes['sip.phoneNumber'] || undefined,
      room: room.name ?? ctx.job.room?.name ?? '',
      sip_call_id: sip.attributes['sip.callID'] || undefined,
    },
  };
}

export interface CallRunnerDeps {
  controlPlane: ControlPlane;
  store: SessionStore;
  conversation?: Conversation;
  onFallback?: FallbackHandler;
}

export function callRunner(deps: CallRunnerDeps): CallHandler {
  const conversation = deps.conversation ?? holdConversation;
  const onFallback = deps.onFallback ?? leaveOnFallback;
  return async (room, ctx) => {
    const req = await bootstrapRequest(room, ctx);
    if (!req) {
      log.warn('job has no call to run (no call_id and no SIP caller)', { jobId: ctx.job.id, room: room.name });
      return;
    }
    let boot;
    try {
      boot = await deps.controlPlane.bootstrap(req);
    } catch (err) {
      const e = err as Error;
      log.error('call bootstrap failed', { jobId: ctx.job.id, room: room.name, status: err instanceof ControlPlaneError ? err.status : undefined, error: e.message });
      return;
    }
    if (boot.action === 'fallback') {
      await onFallback(room, boot, ctx);
      return;
    }
    const session = deps.store.open(boot, room.name ?? '');
    log.info('call session open', {
      jobId: ctx.job.id,
      callId: session.callId,
      tenantId: session.tenantId,
      agentVersion: boot.agent.version_no,
      direction: boot.call.direction,
      test: boot.call.is_test,
      tools: boot.tools.length,
      routing: boot.routing
        ? Object.fromEntries(Object.entries(boot.routing).map(([tier, r]) => [tier, `${r.provider}/${r.model ?? ''}${r.rule_id ? ` (rule ${r.rule_id})` : ''}${r.note ? ` [${r.note}]` : ''}`]))
        : undefined,
    });
    try {
      await conversation(room, session, ctx);
    } finally {
      deps.store.close(session.callId);
      log.info('call session closed', { callId: session.callId, turns: session.turn });
    }
  };
}
