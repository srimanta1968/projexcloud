import { mkdtempSync, readdirSync } from 'fs';
import os from 'os';
import path from 'path';
import { describe, expect, it } from 'vitest';
import { CloseOutBuffer } from '../src/call/closeOut';
import { ControlPlaneError, type CallCloseOut, type ControlPlane } from '../src/controlPlane';

const report: CallCloseOut = {
  status: 'completed',
  turns: [{ turn_index: 0, speaker: 'caller', text: 'hello', started_ms: 0, interrupted: false }],
  started_at: '2026-09-30T10:00:00.000Z',
  ended_at: '2026-09-30T10:01:00.000Z',
  duration_s: 60,
};

/** A control plane that is down until `up` is set; records what it accepted. */
function fakeControlPlane() {
  const cp = {
    up: false,
    refuse: null as number | null,
    accepted: [] as string[],
    async completeCall(callId: string): Promise<{ call_id: string; status: string; turns: number }> {
      if (cp.refuse) throw new ControlPlaneError(cp.refuse, 'ValidationError', 'no');
      if (!cp.up) throw new ControlPlaneError(503, 'HttpError', 'HTTP 503');
      cp.accepted.push(callId);
      return { call_id: callId, status: 'completed', turns: 1 };
    },
  };
  return cp;
}

describe('CloseOutBuffer (TK-4467)', () => {
  it('buffers a close-out to disk while the control plane is down and delivers it later, even from a new process', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'closeout-'));
    const cp = fakeControlPlane();
    const first = new CloseOutBuffer(cp as unknown as ControlPlane, { dir, baseDelayMs: 60_000 });
    await first.start();

    expect(await first.submit('call-1', report)).toBe('buffered');
    expect(readdirSync(dir)).toEqual(['call-1.json']);
    await first.flush(); // still down: stays buffered
    expect(await first.pendingCount()).toBe(1);
    first.stop();

    // The worker restarted; the control plane is back.
    cp.up = true;
    const second = new CloseOutBuffer(cp as unknown as ControlPlane, { dir, baseDelayMs: 60_000 });
    expect(await second.start()).toBe(1);
    await second.flush();
    second.stop();
    expect(cp.accepted).toEqual(['call-1']);
    expect(await second.pendingCount()).toBe(0);

    // A report the control plane refuses outright (4xx) is not retried forever.
    cp.refuse = 400;
    expect(await second.submit('call-2', report)).toBe('dropped');
    expect(readdirSync(dir)).toEqual([]);
  });
});
