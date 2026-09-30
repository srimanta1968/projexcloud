import { Room, RoomEvent, type RemoteParticipant } from '@livekit/rtc-node';
import { log } from '../log';
import type { JobContext, JobRunner } from './worker';

/**
 * What a call does once the agent is in its room. The conversation pipeline plugs in here;
 * it resolves when the call is over (and may disconnect the room itself).
 */
export type CallHandler = (room: Room, ctx: JobContext) => Promise<void>;

/** How long the agent waits in an empty room for the caller before giving up. */
const CALLER_JOIN_TIMEOUT_MS = Number(process.env.VOICE_RUNTIME_CALLER_JOIN_TIMEOUT_MS ?? 60_000);

/**
 * Default call lifetime without a pipeline: stay in the room while a caller is present;
 * finish when the last remote participant leaves, the room closes, the job is aborted, or no
 * caller shows up within CALLER_JOIN_TIMEOUT_MS.
 */
export const holdUntilCallerLeaves: CallHandler = (room, ctx) =>
  new Promise<void>((resolve) => {
    let joinTimer: NodeJS.Timeout | null = null;
    const done = (why: string): void => {
      if (joinTimer) clearTimeout(joinTimer);
      room.off(RoomEvent.ParticipantDisconnected, onLeft);
      room.off(RoomEvent.ParticipantConnected, onJoined);
      room.off(RoomEvent.Disconnected, onClosed);
      ctx.signal.removeEventListener('abort', onAbort);
      log.info('call finished', { jobId: ctx.job.id, room: room.name, why });
      resolve();
    };
    const onLeft = (p: RemoteParticipant): void => {
      log.info('participant left', { jobId: ctx.job.id, identity: p.identity });
      if (room.remoteParticipants.size === 0) done('caller left');
    };
    const onJoined = (p: RemoteParticipant): void => {
      if (joinTimer) { clearTimeout(joinTimer); joinTimer = null; }
      log.info('participant joined', { jobId: ctx.job.id, identity: p.identity });
    };
    const onClosed = (): void => done('room closed');
    const onAbort = (): void => done('job aborted');
    room.on(RoomEvent.ParticipantDisconnected, onLeft);
    room.on(RoomEvent.ParticipantConnected, onJoined);
    room.on(RoomEvent.Disconnected, onClosed);
    ctx.signal.addEventListener('abort', onAbort, { once: true });
    if (room.remoteParticipants.size === 0) {
      joinTimer = setTimeout(() => done('no caller joined'), CALLER_JOIN_TIMEOUT_MS);
    }
  });

/** Joins the job's room as the agent participant, runs `handler`, then leaves. */
export function roomJobRunner(handler: CallHandler = holdUntilCallerLeaves): JobRunner {
  return async (ctx) => {
    const room = new Room();
    await room.connect(ctx.url, ctx.token, { autoSubscribe: true, dynacast: false });
    log.info('agent joined room', {
      jobId: ctx.job.id,
      room: room.name,
      identity: room.localParticipant?.identity,
      remote: [...room.remoteParticipants.keys()],
    });
    try {
      await handler(room, ctx);
    } finally {
      await room.disconnect().catch(() => undefined);
    }
  };
}
