import { describe, expect, it } from 'vitest';
import { AvailabilityRequest, Job, JobAssignment, ServerMessage } from '@livekit/protocol';
import { AgentWorker } from '../src/livekit/worker';
import type { RuntimeConfig } from '../src/config';

const cfg = { maxJobs: 4, livekitUrl: 'ws://livekit:7880', pingIntervalMs: 10_000 } as RuntimeConfig;
const offer = (id: string) => new ServerMessage({ message: { case: 'availability', value: new AvailabilityRequest({ job: new Job({ id }) }) } });
const assign = (id: string) => new ServerMessage({ message: { case: 'assignment', value: new JobAssignment({ job: new Job({ id }), token: 't' }) } });

describe('AgentWorker.drain (TK-4466)', () => {
  it('holds for a call LiveKit was promised but has not assigned yet, and for live calls, then stops offering', async () => {
    let endCall!: () => void;
    const w = new AgentWorker(cfg, () => new Promise<void>((r) => { endCall = r; }));
    const deliver = (m: ServerMessage) => (w as unknown as { onServerMessage(m: ServerMessage): void }).onServerMessage(m);
    const offered: boolean[] = [];
    w.on('offered', (_job, available: boolean) => offered.push(available));

    deliver(offer('job-1'));
    let settled: number | null = null;
    const drained = w.drain(60_000).then((n) => { settled = n; });

    // Draining: a new offer is refused, but the promised job is still being assigned.
    deliver(offer('job-2'));
    await Promise.resolve();
    expect(settled).toBeNull();

    deliver(assign('job-1'));
    await Promise.resolve();
    expect(settled).toBeNull();
    expect(w.state().activeJobs).toBe(1);

    endCall();
    await drained;
    expect(settled).toBe(0);
    expect(offered).toEqual([true, false]);
  });
});
