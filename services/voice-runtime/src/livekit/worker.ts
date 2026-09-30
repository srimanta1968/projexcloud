import { EventEmitter } from 'events';
import WebSocket from 'ws';
import {
  AvailabilityResponse,
  JobStatus,
  JobType,
  RegisterWorkerRequest,
  ServerMessage,
  UpdateJobStatus,
  UpdateWorkerStatus,
  WorkerMessage,
  WorkerPing,
  WorkerStatus,
  type Job,
} from '@livekit/protocol';
import type { RuntimeConfig } from '../config';
import { log } from '../log';
import { signWorkerToken } from './token';

/**
 * LiveKit agent-worker client (VA·E1 · TK-4455).
 *
 * Speaks LiveKit's worker protocol (protobuf WorkerMessage/ServerMessage over a WebSocket
 * on /agent) directly: register under `agentName`, answer availability offers, accept
 * job assignments, report job and worker status, ping. LiveKit then dispatches every room
 * created with `roomConfig.agents: [{ agentName }]` — browser test sessions (sdk-voice-agent
 * signParticipantToken) and SIP calls (the dispatch rule provisionTrunk creates) — to one
 * registered worker, which runs the call through the JobRunner.
 *
 * Why not the agents-js framework: it pulls sharp, ffmpeg bindings, an ONNX inference
 * package and the OpenTelemetry SDK into every workspace image (five Dockerfiles install the
 * whole workspace), on Alpine where its media binding cannot load. The protocol is small;
 * media uses @livekit/rtc-node, the same native binding agents-js uses.
 *
 * A job keeps running across a signaling reconnect: the call's room connection is
 * independent of this socket.
 */

export interface JobContext {
  job: Job;
  /** LiveKit URL to join the room on (the assignment's, else the worker's). */
  url: string;
  /** Room token LiveKit minted for this job's agent participant. */
  token: string;
  /** Aborted when LiveKit terminates the job or the worker is force-stopped. */
  signal: AbortSignal;
}

export type JobRunner = (ctx: JobContext) => Promise<void>;

/** How long an "available" answer holds capacity while LiveKit decides on the assignment. */
const PENDING_ASSIGNMENT_MS = 15_000;

interface ActiveJob { job: Job; startedAt: number; abort: AbortController }

export interface WorkerState {
  connected: boolean;
  registered: boolean;
  workerId: string | null;
  draining: boolean;
  activeJobs: number;
  maxJobs: number;
  jobsAccepted: number;
  jobsCompleted: number;
  jobsFailed: number;
  lastPongAt: number | null;
}

export class AgentWorker extends EventEmitter {
  private ws: WebSocket | null = null;
  private stopped = false;
  private draining = false;
  private workerId: string | null = null;
  private registered = false;
  private backoffMs = 500;
  private pingTimer: NodeJS.Timeout | null = null;
  private statusTimer: NodeJS.Timeout | null = null;
  private lastPongAt: number | null = null;
  private readonly jobs = new Map<string, ActiveJob>();
  /** Jobs we told LiveKit we would take, until their assignment arrives (or it never does). */
  private readonly pending = new Map<string, NodeJS.Timeout>();
  private counts = { accepted: 0, completed: 0, failed: 0 };

  constructor(private readonly cfg: RuntimeConfig, private readonly runner: JobRunner) {
    super();
  }

  state(): WorkerState {
    return {
      connected: this.ws?.readyState === WebSocket.OPEN,
      registered: this.registered,
      workerId: this.workerId,
      draining: this.draining,
      activeJobs: this.jobs.size,
      maxJobs: this.cfg.maxJobs,
      jobsAccepted: this.counts.accepted,
      jobsCompleted: this.counts.completed,
      jobsFailed: this.counts.failed,
      lastPongAt: this.lastPongAt,
    };
  }

  activeJobIds(): string[] {
    return [...this.jobs.keys()];
  }

  start(): void {
    this.stopped = false;
    this.connect();
  }

  private agentUrl(): string {
    return `${this.cfg.livekitUrl.replace(/^http/, 'ws')}/agent`;
  }

  private connect(): void {
    if (this.stopped) return;
    const token = signWorkerToken(this.cfg.apiKey, this.cfg.apiSecret, `voice-runtime-${this.cfg.workerName}`);
    const ws = new WebSocket(this.agentUrl(), { headers: { Authorization: `Bearer ${token}` } });
    this.ws = ws;
    ws.binaryType = 'nodebuffer';
    ws.on('open', () => {
      this.backoffMs = 500;
      log.info('connected to LiveKit, registering', { url: this.agentUrl(), agentName: this.cfg.agentName });
      this.send(new WorkerMessage({
        message: {
          case: 'register',
          value: new RegisterWorkerRequest({
            type: JobType.JT_ROOM,
            agentName: this.cfg.agentName,
            version: this.cfg.workerVersion,
            pingInterval: Math.round(this.cfg.pingIntervalMs / 1000),
          }),
        },
      }));
    });
    ws.on('message', (data: Buffer) => {
      let msg: ServerMessage;
      try {
        msg = ServerMessage.fromBinary(new Uint8Array(data));
      } catch (err) {
        log.warn('unparseable server message', { error: (err as Error).message });
        return;
      }
      this.onServerMessage(msg);
    });
    ws.on('unexpected-response', (_req, res) => {
      log.error('LiveKit refused the worker connection', { status: res.statusCode });
    });
    ws.on('error', (err) => log.warn('worker socket error', { error: err.message }));
    ws.on('close', (code) => {
      const was = this.registered;
      this.registered = false;
      this.clearTimers();
      if (this.ws === ws) this.ws = null;
      if (was) this.emit('unregistered');
      if (this.stopped) return;
      const wait = this.backoffMs;
      this.backoffMs = Math.min(this.backoffMs * 2, 30_000);
      log.warn('worker socket closed, reconnecting', { code, inMs: wait, activeJobs: this.jobs.size });
      setTimeout(() => this.connect(), wait).unref();
    });
  }

  private send(msg: WorkerMessage): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(msg.toBinary());
  }

  private onServerMessage(msg: ServerMessage): void {
    switch (msg.message.case) {
      case 'register': {
        this.workerId = msg.message.value.workerId;
        this.registered = true;
        log.info('worker registered', { workerId: this.workerId, server: msg.message.value.serverInfo?.version });
        this.startTimers();
        this.sendStatus();
        this.emit('registered', this.workerId);
        return;
      }
      case 'availability': {
        const job = msg.message.value.job;
        if (!job) return;
        const available = this.canAccept();
        if (available) this.holdPending(job.id);
        log.info('job offered', { jobId: job.id, room: job.room?.name, available });
        this.send(new WorkerMessage({
          message: {
            case: 'availability',
            value: new AvailabilityResponse({
              jobId: job.id,
              available,
              participantIdentity: `agent-${job.id}`,
              participantName: 'Voice agent',
              participantMetadata: JSON.stringify({ worker: this.cfg.workerName }),
            }),
          },
        }));
        this.emit('offered', job, available);
        return;
      }
      case 'assignment': {
        const { job, url, token } = msg.message.value;
        if (!job) return;
        // Running first, then released: never a moment with neither, which would end a drain.
        this.runJob(job, url || this.cfg.livekitUrl, token);
        this.releasePending(job.id);
        return;
      }
      case 'termination': {
        const active = this.jobs.get(msg.message.value.jobId);
        log.info('job terminated by LiveKit', { jobId: msg.message.value.jobId, known: !!active });
        active?.abort.abort(new Error('terminated by LiveKit'));
        return;
      }
      case 'pong':
        this.lastPongAt = Date.now();
        return;
      default:
        return;
    }
  }

  /**
   * A job we answered "available" for counts against capacity — and holds a drain open —
   * until LiveKit assigns it. LiveKit may give it to another worker instead, so the hold
   * lapses after PENDING_ASSIGNMENT_MS.
   */
  private holdPending(jobId: string): void {
    const t = setTimeout(() => this.releasePending(jobId), PENDING_ASSIGNMENT_MS);
    t.unref();
    this.pending.set(jobId, t);
  }

  private releasePending(jobId: string): void {
    const t = this.pending.get(jobId);
    if (!t) return;
    clearTimeout(t);
    this.pending.delete(jobId);
    this.emitIfIdle();
  }

  /** Nothing running and nothing promised: a drain may finish. */
  private emitIfIdle(): void {
    if (this.jobs.size === 0 && this.pending.size === 0) this.emit('idle');
  }

  private canAccept(): boolean {
    return !this.draining && !this.stopped && this.jobs.size + this.pending.size < this.cfg.maxJobs;
  }

  private runJob(job: Job, url: string, token: string): void {
    const abort = new AbortController();
    this.jobs.set(job.id, { job, startedAt: Date.now(), abort });
    this.counts.accepted += 1;
    this.updateJob(job.id, JobStatus.JS_RUNNING);
    this.sendStatus();
    log.info('job started', { jobId: job.id, room: job.room?.name, activeJobs: this.jobs.size });
    this.emit('jobStarted', job);
    this.runner({ job, url, token, signal: abort.signal })
      .then(() => {
        this.counts.completed += 1;
        this.updateJob(job.id, JobStatus.JS_SUCCESS);
        log.info('job finished', { jobId: job.id });
      })
      .catch((err: Error) => {
        this.counts.failed += 1;
        this.updateJob(job.id, JobStatus.JS_FAILED, err.message);
        log.error('job failed', { jobId: job.id, error: err.message });
      })
      .finally(() => {
        this.jobs.delete(job.id);
        this.sendStatus();
        this.emit('jobEnded', job);
        this.emitIfIdle();
      });
  }

  private updateJob(jobId: string, status: JobStatus, error = ''): void {
    this.send(new WorkerMessage({ message: { case: 'updateJob', value: new UpdateJobStatus({ jobId, status, error }) } }));
  }

  /** Tells LiveKit whether to keep offering jobs (full while draining or at capacity). */
  private sendStatus(): void {
    const full = this.draining || this.jobs.size >= this.cfg.maxJobs;
    this.send(new WorkerMessage({
      message: {
        case: 'updateWorker',
        value: new UpdateWorkerStatus({
          status: full ? WorkerStatus.WS_FULL : WorkerStatus.WS_AVAILABLE,
          load: Math.min(1, this.jobs.size / this.cfg.maxJobs),
          jobCount: this.jobs.size,
        }),
      },
    }));
  }

  private startTimers(): void {
    this.clearTimers();
    this.pingTimer = setInterval(() => {
      this.send(new WorkerMessage({ message: { case: 'ping', value: new WorkerPing({ timestamp: BigInt(Date.now()) }) } }));
      // Two missed pongs: the socket is half-open; drop it so the reconnect loop takes over.
      if (this.lastPongAt !== null && Date.now() - this.lastPongAt > this.cfg.pingIntervalMs * 3) {
        log.warn('no pong from LiveKit, recycling the worker socket');
        this.ws?.terminate();
      }
    }, this.cfg.pingIntervalMs);
    this.pingTimer.unref();
    this.statusTimer = setInterval(() => this.sendStatus(), 5000);
    this.statusTimer.unref();
  }

  private clearTimers(): void {
    if (this.pingTimer) clearInterval(this.pingTimer);
    if (this.statusTimer) clearInterval(this.statusTimer);
    this.pingTimer = this.statusTimer = null;
  }

  /**
   * Stops taking calls (LiveKit sees the worker FULL, so no new job is offered) and resolves
   * once every live call has ended — including a call LiveKit was already promised and is
   * still assigning (TK-4466) — or when `timeoutMs` passes, whichever is first.
   * Returns the number of calls still running at that point.
   */
  drain(timeoutMs: number): Promise<number> {
    this.draining = true;
    this.sendStatus();
    this.emit('draining');
    log.info('draining', { activeJobs: this.jobs.size, pendingJobs: this.pending.size, timeoutMs });
    if (this.jobs.size === 0 && this.pending.size === 0) return Promise.resolve(0);
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.off('idle', onIdle);
        resolve(this.jobs.size);
      }, timeoutMs);
      const onIdle = (): void => {
        clearTimeout(timer);
        resolve(0);
      };
      this.once('idle', onIdle);
    });
  }

  /** Closes the socket; running jobs are aborted only when `abortJobs` is set. */
  stop(abortJobs = false): void {
    this.stopped = true;
    this.clearTimers();
    if (abortJobs) for (const j of this.jobs.values()) j.abort.abort(new Error('worker stopped'));
    this.ws?.close(1000);
  }
}
