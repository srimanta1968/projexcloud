import { promises as fs } from 'fs';
import path from 'path';
import { ControlPlaneError, type CallCloseOut, type ControlPlane } from '../controlPlane';
import { log } from '../log';

/**
 * Buffered call close-out (VA·E1 · TK-4467).
 *
 * A call's transcript lives in worker memory until it ends; then it is written in ONE request
 * (POST /api/admin/voice-agent/calls/:id/complete — turns, outcome; the control plane
 * summarises and mirrors). If the control plane is unavailable at that moment the report is
 * spooled to a local file first and retried with backoff — across a worker restart, since
 * the spool directory is a volume and pending files are replayed on boot — so a completed
 * call's transcript and summary are persisted even when the control plane was briefly down.
 *
 *   retryable: unreachable, 429, 5xx          -> keep in the spool, retry
 *   final:     2xx; 400 / 404 / 409 (a report the control plane will never accept) -> drop
 *
 * Repeats are harmless: completeCall upserts turns and emits the completion event once.
 */

export interface CloseOutOptions {
  dir: string;
  /** Backoff between retries: starts here, doubles, capped at maxDelayMs. */
  baseDelayMs?: number;
  maxDelayMs?: number;
  /** A report older than this is moved to *.dead and no longer retried. */
  maxAgeMs?: number;
}

interface Spooled { call_id: string; queued_at: number; attempts: number; report: CallCloseOut }

export function isRetryableCloseOut(err: unknown): boolean {
  if (!(err instanceof ControlPlaneError)) return true; // network / timeout
  return err.status === 429 || err.status >= 500;
}

export class CloseOutBuffer {
  private readonly baseDelayMs: number;
  private readonly maxDelayMs: number;
  private readonly maxAgeMs: number;
  private timer: NodeJS.Timeout | null = null;
  private delayMs: number;
  private flushing: Promise<void> | null = null;

  constructor(private readonly controlPlane: ControlPlane, private readonly opts: CloseOutOptions) {
    this.baseDelayMs = opts.baseDelayMs ?? 1000;
    this.maxDelayMs = opts.maxDelayMs ?? 60_000;
    this.maxAgeMs = opts.maxAgeMs ?? 7 * 24 * 60 * 60 * 1000;
    this.delayMs = this.baseDelayMs;
  }

  private file(callId: string): string {
    return path.join(this.opts.dir, `${callId.replace(/[^0-9a-zA-Z-]/g, '')}.json`);
  }

  /** Creates the spool and replays whatever a previous process left in it. */
  async start(): Promise<number> {
    await fs.mkdir(this.opts.dir, { recursive: true });
    const pending = await this.pendingFiles();
    if (pending.length) {
      log.info('replaying buffered call close-outs', { count: pending.length });
      this.schedule(0);
    }
    return pending.length;
  }

  /**
   * Reports a finished call. Resolves once the report is either accepted by the control plane
   * or safely on disk for retry — never rejects, so a call's teardown cannot fail on it.
   */
  async submit(callId: string, report: CallCloseOut): Promise<'sent' | 'buffered' | 'dropped'> {
    try {
      await this.controlPlane.completeCall(callId, report);
      return 'sent';
    } catch (err) {
      if (!isRetryableCloseOut(err)) {
        log.error('control plane refused the call close-out, dropping it', { callId, error: (err as Error).message });
        return 'dropped';
      }
      const entry: Spooled = { call_id: callId, queued_at: Date.now(), attempts: 1, report };
      try {
        await this.write(entry);
      } catch (writeErr) {
        log.error('could not buffer call close-out — transcript lost', { callId, error: (writeErr as Error).message });
        return 'dropped';
      }
      log.warn('control plane unavailable, call close-out buffered', { callId, error: (err as Error).message });
      this.schedule(this.delayMs);
      return 'buffered';
    }
  }

  /** One pass over the spool now (also used on shutdown). Resolves when the pass is done. */
  flush(): Promise<void> {
    if (!this.flushing) this.flushing = this.pass().finally(() => { this.flushing = null; });
    return this.flushing;
  }

  async pendingCount(): Promise<number> {
    return (await this.pendingFiles()).length;
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private schedule(ms: number): void {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.flush().then(async () => {
        if ((await this.pendingCount()) > 0) {
          this.delayMs = Math.min(this.delayMs * 2, this.maxDelayMs);
          this.schedule(this.delayMs);
        } else {
          this.delayMs = this.baseDelayMs;
        }
      });
    }, ms);
    this.timer.unref();
  }

  private async pass(): Promise<void> {
    for (const f of await this.pendingFiles()) {
      let entry: Spooled;
      try {
        entry = JSON.parse(await fs.readFile(f, 'utf8')) as Spooled;
      } catch (err) {
        log.error('unreadable buffered close-out, setting it aside', { file: f, error: (err as Error).message });
        await fs.rename(f, `${f}.dead`).catch(() => undefined);
        continue;
      }
      try {
        await this.controlPlane.completeCall(entry.call_id, entry.report);
        await fs.unlink(f).catch(() => undefined);
        log.info('buffered call close-out delivered', { callId: entry.call_id, attempts: entry.attempts + 1, delayed_ms: Date.now() - entry.queued_at });
      } catch (err) {
        if (!isRetryableCloseOut(err)) {
          log.error('control plane refused a buffered close-out, dropping it', { callId: entry.call_id, error: (err as Error).message });
          await fs.unlink(f).catch(() => undefined);
          continue;
        }
        entry.attempts += 1;
        if (Date.now() - entry.queued_at > this.maxAgeMs) {
          log.error('buffered close-out expired, setting it aside', { callId: entry.call_id, attempts: entry.attempts });
          await fs.rename(f, `${f}.dead`).catch(() => undefined);
          continue;
        }
        await this.write(entry).catch(() => undefined);
        // The control plane is still down: the rest of the spool would fail the same way.
        return;
      }
    }
  }

  private async write(entry: Spooled): Promise<void> {
    const f = this.file(entry.call_id);
    const tmp = `${f}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(entry));
    await fs.rename(tmp, f); // atomic: a crash never leaves a half-written report
  }

  private async pendingFiles(): Promise<string[]> {
    const names = await fs.readdir(this.opts.dir).catch(() => [] as string[]);
    return names.filter((n) => n.endsWith('.json')).sort().map((n) => path.join(this.opts.dir, n));
  }
}
